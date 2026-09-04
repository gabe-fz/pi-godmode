import {
  ROADMAP_STATUSES,
  WORKFLOW_ACTORS,
  WORKFLOW_CLASSIFICATIONS,
  WORKFLOW_PHASES,
  type RoadmapStatus,
  type WorkflowActor,
  type WorkflowClassification,
  type WorkflowPhase,
  type RedTestEvidence,
  type TddWaiver,
  type WorkflowRecord,
  type WorkflowRoadmapItem,
  type FunctionalRequirement,
} from "./types.ts";

const CLASSIFICATIONS = new Set<string>(WORKFLOW_CLASSIFICATIONS);
const PHASES = new Set<string>(WORKFLOW_PHASES);
const STATUSES = new Set<string>(ROADMAP_STATUSES);
const ACTORS = new Set<string>(WORKFLOW_ACTORS);
// Every gate that changes what Hand may be told is Primary-authored. Keep
// this independent from operational mode phases: model-facing input never
// supplies any of these audit fields.
const PRIMARY_ONLY_PHASES = new Set<WorkflowPhase>(WORKFLOW_PHASES.filter((phase) => phase !== "draft"));
const PRIMARY_ONLY_ROADMAP_STATUSES = new Set<RoadmapStatus>(["verified", "waived"]);

const ROADMAP_TRANSITIONS: Readonly<Record<RoadmapStatus, readonly RoadmapStatus[]>> = {
  pending: ["implemented-unverified", "blocked", "waived"],
  "implemented-unverified": ["verified", "blocked", "waived"],
  blocked: ["pending", "implemented-unverified", "waived"],
  verified: [],
  waived: [],
};

export interface PhaseTransitionInput {
  to: WorkflowPhase;
  actor: WorkflowActor;
  timestamp: string;
  reason: string;
  reference: string;
}

export interface RoadmapTransitionInput {
  to: RoadmapStatus;
  actor: WorkflowActor;
  timestamp: string;
  reason: string;
  reference: string;
}

export interface ValidWorkflowRecord {
  ok: true;
  record: WorkflowRecord;
}

export interface InvalidWorkflowRecord {
  ok: false;
  blocked: WorkflowRecord;
  reason: string;
}

export type WorkflowValidation = ValidWorkflowRecord | InvalidWorkflowRecord;

const PHASE_TRANSITIONS: Readonly<Record<WorkflowPhase, readonly WorkflowPhase[]>> = {
  draft: ["classified", "blocked"],
  classified: ["specified", "blocked"],
  specified: ["red-test-ready", "blocked"],
  "red-test-ready": ["red-test-observed", "tdd-waived", "blocked"],
  "red-test-observed": ["hand-running", "blocked"],
  "tdd-waived": ["hand-running", "blocked"],
  "hand-running": ["hand-handoff", "blocked"],
  "hand-handoff": ["primary-verifying", "blocked"],
  "primary-verifying": ["evidence-ready", "remediation", "blocked"],
  "evidence-ready": ["scale-running", "scale-waived", "blocked"],
  "scale-running": ["review-passed", "remediation", "blocked"],
  "review-passed": ["accepted", "rejected", "blocked"],
  "scale-waived": ["accepted", "blocked"],
  accepted: [],
  remediation: ["hand-running", "blocked"],
  blocked: ["specified", "red-test-ready", "hand-running", "primary-verifying", "scale-running"],
  rejected: [],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPhase(value: unknown): value is WorkflowPhase {
  return typeof value === "string" && PHASES.has(value);
}

function isStatus(value: unknown): value is RoadmapStatus {
  return typeof value === "string" && STATUSES.has(value);
}

function isActor(value: unknown): value is WorkflowActor {
  return typeof value === "string" && ACTORS.has(value);
}

function cloneRecord(record: WorkflowRecord): WorkflowRecord {
  const cloned: WorkflowRecord = {
    workItemId: record.workItemId,
    classification: record.classification,
    goal: record.goal,
    requirementIds: [...record.requirementIds],
    ...(record.functionalRequirements !== undefined
      ? { functionalRequirements: record.functionalRequirements.map((requirement) => ({ ...requirement })) }
      : {}),
    nonGoals: [...record.nonGoals],
    expectedPaths: [...record.expectedPaths],
    phase: record.phase,
    roadmap: record.roadmap.map((item) => ({
      id: item.id,
      requirementIds: [...item.requirementIds],
      title: item.title,
      status: item.status,
      ...(item.reason !== undefined ? { reason: item.reason } : {}),
    })),
    history: record.history.map((entry) => ({ ...entry })),
    nextGate: record.nextGate,
    blockers: [...record.blockers],
    residualRisks: [...record.residualRisks],
    evidence: record.evidence.map((reference) => ({ ...reference })),
  };
  const optionalKeys = [
    "unresolvedDecisions",
    "redTestReference",
    "tddWaiverReference",
    "scaleVerdict",
    "scaleWaiverReference",
    "changedScopeSummary",
    "latestCapsuleReference",
    "packetAuthor",
    "acceptanceChecks",
    "authorityConstraints",
    "redTestEvidence",
    "tddWaiver",
  ] as const;
  for (const key of optionalKeys) {
    const value = record[key];
    if (value !== undefined) {
      let copied: unknown = Array.isArray(value) ? [...value] : value;
      if (key === "redTestEvidence" && isObject(value)) {
        const objectValue = value as Record<string, unknown>;
        copied = {
          ...objectValue,
          requirementIds: Array.isArray(objectValue.requirementIds) ? [...objectValue.requirementIds] : objectValue.requirementIds,
          ...(isObject(objectValue.artifactReference) ? { artifactReference: { ...objectValue.artifactReference } } : {}),
        };
      } else if (key === "tddWaiver" && isObject(value)) {
        const objectValue = value as Record<string, unknown>;
        copied = {
          ...objectValue,
          requirementIds: Array.isArray(objectValue.requirementIds) ? [...objectValue.requirementIds] : objectValue.requirementIds,
          scope: Array.isArray(objectValue.scope) ? [...objectValue.scope] : objectValue.scope,
          ...(isObject(objectValue.compensatingEvidence) ? { compensatingEvidence: { ...objectValue.compensatingEvidence } } : {}),
        };
      }
      (cloned as unknown as Record<string, unknown>)[key] = copied;
    }
  }
  return cloned;
}

function blockedRecord(record: unknown, reason: string): WorkflowRecord {
  // A malformed value cannot safely be copied as a canonical record. Retain
  // only bounded, known fields when possible, and always force the phase to
  // blocked. This is a recovery state, not an authority-bearing transition.
  if (!isObject(record)) {
    return {
      workItemId: "unknown",
      classification: "feature",
      goal: "",
      requirementIds: [],
      nonGoals: [],
      expectedPaths: [],
      phase: "blocked",
      roadmap: [],
      history: [],
      nextGate: "primary-reconcile",
      blockers: [reason],
      residualRisks: [],
      evidence: [],
    };
  }
  const candidate = record as Partial<WorkflowRecord>;
  const fallback = (value: unknown): string => typeof value === "string" ? value : "";
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 64) : [];
  const roadmap = Array.isArray(candidate.roadmap) ? candidate.roadmap.filter(isRoadmapItem).slice(0, 64).map((item) => ({
    id: item.id,
    requirementIds: [...item.requirementIds],
    title: item.title,
    status: item.status,
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
  })) : [];
  return {
    workItemId: fallback(candidate.workItemId) || "unknown",
    classification: CLASSIFICATIONS.has(candidate.classification as string) ? candidate.classification as WorkflowClassification : "feature",
    goal: fallback(candidate.goal),
    requirementIds: strings(candidate.requirementIds),
    nonGoals: strings(candidate.nonGoals),
    expectedPaths: strings(candidate.expectedPaths),
    phase: "blocked",
    roadmap,
    history: [],
    nextGate: fallback(candidate.nextGate) || "primary-reconcile",
    blockers: [...strings(candidate.blockers), reason].slice(0, 64),
    residualRisks: strings(candidate.residualRisks),
    evidence: [],
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRoadmapItem(value: unknown): value is WorkflowRoadmapItem {
  return isObject(value)
    && nonEmptyString(value.id)
    && isStringArray(value.requirementIds)
    && nonEmptyString(value.title)
    && isStatus(value.status)
    && (value.reason === undefined || typeof value.reason === "string");
}

const REQUIREMENT_ID = /^FR-[1-9]\d*$/u;

function isFunctionalRequirement(value: unknown): value is FunctionalRequirement {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3
    && keys.every((key) => key === "id" || key === "description" || key === "interface")
    && REQUIREMENT_ID.test(typeof value.id === "string" ? value.id : "")
    && boundedPacketString(value.description, 8 * 1024)
    && boundedPacketString(value.interface, 4 * 1024);
}

function validFunctionalRequirements(value: unknown, requirementIds: readonly string[]): value is FunctionalRequirement[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64 || !value.every(isFunctionalRequirement)) return false;
  if (value.some((requirement) => requirement.description.trim() === requirement.id || requirement.interface.trim() === requirement.id)) return false;
  const ids = value.map((requirement) => requirement.id);
  const declared = new Set(requirementIds);
  return ids.length === new Set(ids).size
    && ids.length === declared.size
    && ids.every((id) => declared.has(id));
}
const SHA256_HEX = /^[0-9a-f]{64}$/u;

const RED_EVIDENCE_KEYS = new Set([
  "id", "command", "environment", "exitStatus", "requirementIds", "testPath", "testContentHash",
  "observedBy", "observedAt", "failureKind", "outputExcerpt", "artifactReference",
]);
const TDD_WAIVER_KEYS = new Set([
  "id", "item", "requirementIds", "inapplicableSeam", "reason", "actor", "approver",
  "date", "scope", "compensatingCheck", "compensatingEvidence",
]);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === new Set(keys).size && keys.every((key) => allowed.has(key));
}

/**
 * Feature/bugfix TDD waivers are exceptional: the absence must describe a
 * real safe executable seam, rather than merely asserting that a test is
 * inconvenient. Accept common natural-language orderings while requiring
 * both a seam and an explicit unavailable/no-seam signal.
 */
function hasUnavailableSafeExecutableSeam(value: string): boolean {
  const text = value.toLowerCase();
  const namesSeam = /\b(?:safe|executable|test)\b.{0,64}\bseam\b/iu.test(text)
    || /\bseam\b.{0,64}\b(?:safe|executable|test)\b/iu.test(text);
  if (!namesSeam) return false;
  return /\b(?:unavailable|not\s+available|does\s+not\s+exist|cannot\s+be\s+(?:used|provided)|no\s+(?:safe|executable|test|such)\b)/iu.test(text)
    || /\bno\b.{0,96}\b(?:safe|executable|test)\b.{0,64}\bseam\b/iu.test(text);
}
const PACKET_REQUIRED_PHASES = new Set<WorkflowPhase>([
  "specified",
  "red-test-ready",
  "red-test-observed",
  "tdd-waived",
  "hand-running",
  "hand-handoff",
  "primary-verifying",
  "evidence-ready",
  "scale-running",
  "review-passed",
  "scale-waived",
  "accepted",
  "remediation",
  "rejected",
]);
const PACKET_FIELDS = ["packetAuthor", "acceptanceChecks", "authorityConstraints"] as const;

function boundedPacketString(value: unknown, maximum = 32 * 1024): value is string {
  return nonEmptyString(value) && Buffer.byteLength(value, "utf8") <= maximum && !value.includes("\0");
}

function packetStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 64
    && value.every((entry) => boundedPacketString(entry, 4 * 1024));
}

function validArtifactReference(value: unknown): boolean {
  if (typeof value === "string") return boundedPacketString(value, 4 * 1024);
  if (!isObject(value) || !hasOnlyKeys(value, new Set(["id", "kind", "label", "source", "createdAt", "expiresAt"])) || !boundedPacketString(value.id, 256)) return false;
  return Object.entries(value).every(([key, entry]) =>
    ["id", "kind", "label", "source", "createdAt", "expiresAt"].includes(key)
      && (entry === undefined || boundedPacketString(entry, 1024)));
}

function validPacketMetadata(record: Record<string, unknown>): boolean {
  return record.packetAuthor === "Primary"
    && boundedPacketString(record.goal, 32 * 1024)
    && Array.isArray(record.requirementIds)
    && record.requirementIds.length > 0
    && validFunctionalRequirements(record.functionalRequirements, record.requirementIds.filter((id): id is string => typeof id === "string"))
    && Array.isArray(record.nonGoals)
    && record.nonGoals.length > 0
    && Array.isArray(record.roadmap)
    && record.roadmap.length > 0
    && Array.isArray(record.expectedPaths)
    && record.expectedPaths.length > 0
    && packetStringArray(record.acceptanceChecks)
    && packetStringArray(record.authorityConstraints);
}

function canonicalDate(value: unknown): value is string {
  if (typeof value !== "string" || !boundedPacketString(value, 128)) return false;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validRedTestEvidence(value: unknown, declaredRequirements: Set<string>): value is RedTestEvidence {
  if (!isObject(value)
    || !hasOnlyKeys(value, RED_EVIDENCE_KEYS)
    || !boundedPacketString(value.id, 256)
    || !boundedPacketString(value.command, 8 * 1024)
    || !boundedPacketString(value.environment, 4 * 1024)
    || typeof value.exitStatus !== "number"
    || !Number.isSafeInteger(value.exitStatus)
    || value.exitStatus === 0
    || !packetStringArray(value.requirementIds)
    || !value.requirementIds.every((id) => REQUIREMENT_ID.test(id) && declaredRequirements.has(id))
    || !boundedPacketString(value.testPath, 4 * 1024)
    || !SHA256_HEX.test(typeof value.testContentHash === "string" ? value.testContentHash : "")
    || value.observedBy !== "Primary"
    || !canonicalDate(value.observedAt)
    || value.failureKind !== "missing-behavior") return false;
  if (value.requirementIds.length !== new Set(value.requirementIds).size) return false;
  const excerpt = value.outputExcerpt;
  const artifact = value.artifactReference;
  if (excerpt === undefined && artifact === undefined) return false;
  if (excerpt !== undefined && !boundedPacketString(excerpt, 8 * 1024)) return false;
  if (artifact !== undefined && !validArtifactReference(artifact)) return false;
  return value.requirementIds.length === declaredRequirements.size
    && value.requirementIds.every((id) => declaredRequirements.has(id));
}

function validTddWaiver(value: unknown, declaredRequirements: Set<string>, classification?: WorkflowClassification): value is TddWaiver {
  if (!isObject(value)
    || !hasOnlyKeys(value, TDD_WAIVER_KEYS)
    || !boundedPacketString(value.id, 256)
    || !boundedPacketString(value.item, 256)
    || !packetStringArray(value.requirementIds)
    || !value.requirementIds.every((id) => REQUIREMENT_ID.test(id) && declaredRequirements.has(id))
    || value.requirementIds.length !== new Set(value.requirementIds).size
    || !boundedPacketString(value.inapplicableSeam, 4 * 1024)
    || !boundedPacketString(value.reason, 8 * 1024)
    || (value.actor !== undefined && value.actor !== "Primary")
    || (value.approver !== undefined && value.approver !== "Primary")
    || (value.actor === undefined && value.approver === undefined)
    || !canonicalDate(value.date)) return false;
  const scope = value.scope;
  const scopeValid = typeof scope === "string"
    ? boundedPacketString(scope, 4 * 1024)
    : packetStringArray(scope);
  if (!scopeValid) return false;
  const reason = value.reason.toLowerCase();
  if (/time\s*pressure|deadline|capacity|convenience|no\s*time|urgent/iu.test(reason)) return false;
  const broad = typeof scope === "string" ? scope : (scope as string[]).join(" ");
  if (/^\s*(all|any|everything|entire|whole)\b|\b(entire|whole)\s+(?:project|repository|codebase|checkout|work)|\b(all changes|all future work)\b/iu.test(broad)) return false;
  if (value.compensatingCheck === undefined && value.compensatingEvidence === undefined) return false;
  if (value.compensatingCheck !== undefined && !boundedPacketString(value.compensatingCheck, 8 * 1024)) return false;
  if (value.compensatingEvidence !== undefined && !validArtifactReference(value.compensatingEvidence)) return false;
  // A feature/bugfix waiver is allowed only for the explicitly documented
  // genuinely unavailable safe seam; documentation-only and mechanical
  // changes can use their named inapplicable seam.
  const itemReason = `${value.item} ${value.inapplicableSeam} ${value.reason}`;
  if ((classification === "feature" || classification === "bugfix")
    && !hasUnavailableSafeExecutableSeam(itemReason)) return false;
  return value.requirementIds.length === declaredRequirements.size
    && value.requirementIds.every((id) => declaredRequirements.has(id));
}

export function validateTddWaiver(value: unknown, requirementIds: readonly string[], classification?: WorkflowClassification): boolean {
  return validTddWaiver(value, new Set(requirementIds), classification);
}

/**
 * Validate packet metadata at a persistence/admission boundary. Draft records
 * may omit packet fields for schema-v1 recovery, but once packet metadata is
 * present (or the record is beyond draft) all structured gate objects must be
 * complete and internally attributable.
 */
export function validateWorkflowPacket(record: unknown): boolean {
  if (!isObject(record) || !isPhase(record.phase)) return false;
  const hasPacketField = PACKET_FIELDS.some((field) => record[field] !== undefined);
  const hasGateMetadata = record.redTestEvidence !== undefined || record.tddWaiver !== undefined;
  const phase = record.phase;
  if (!hasPacketField && !hasGateMetadata && !PACKET_REQUIRED_PHASES.has(phase as WorkflowPhase)) return true;
  // Schema-v1 drafts may carry the older packet fields without structured
  // functional requirements. They remain drafts and cannot pass Hand gates;
  // every specified/pre-Hand phase still requires the complete structure.
  if (phase === "draft" && !hasGateMetadata && record.functionalRequirements === undefined) return true;
  if (!validPacketMetadata(record)) return false;
  if (!Array.isArray(record.requirementIds)) return false;
  const requirements = new Set(record.requirementIds.filter((id): id is string => typeof id === "string"));
  const redEvidence = record.redTestEvidence;
  const tddWaiver = record.tddWaiver;
  const hasRedEvidence = redEvidence !== undefined;
  const hasTddWaiver = tddWaiver !== undefined;
  if (hasRedEvidence && hasTddWaiver) return false;
  if (redEvidence !== undefined && !validRedTestEvidence(redEvidence, requirements)) return false;
  if (tddWaiver !== undefined && (!validTddWaiver(tddWaiver, requirements, record.classification as WorkflowClassification)
    || tddWaiver.item !== record.workItemId)) return false;
  if (redEvidence === undefined && record.redTestReference !== undefined) return false;
  if (tddWaiver === undefined && record.tddWaiverReference !== undefined) return false;
  if (redEvidence !== undefined && record.redTestReference !== undefined && record.redTestReference !== redEvidence.id) return false;
  if (tddWaiver !== undefined && record.tddWaiverReference !== undefined && record.tddWaiverReference !== tddWaiver.id) return false;
  const redEvidencePhases = new Set<WorkflowPhase>([
    "red-test-observed", "hand-running", "hand-handoff", "primary-verifying", "evidence-ready",
    "scale-running", "review-passed", "scale-waived", "accepted", "remediation", "blocked", "rejected",
  ]);
  const tddWaiverPhases = new Set<WorkflowPhase>([
    "tdd-waived", "hand-running", "hand-handoff", "primary-verifying", "evidence-ready",
    "scale-running", "review-passed", "scale-waived", "accepted", "remediation", "blocked", "rejected",
  ]);
  if (hasRedEvidence && !redEvidencePhases.has(phase as WorkflowPhase)) return false;
  if (hasTddWaiver && !tddWaiverPhases.has(phase as WorkflowPhase)) return false;
  if (phase === "red-test-observed" && !hasRedEvidence) return false;
  if (phase === "tdd-waived" && !hasTddWaiver) return false;
  if ((hasRedEvidence && phase === "tdd-waived") || (hasTddWaiver && phase === "red-test-observed")) return false;
  const handGatePhases = new Set<WorkflowPhase>([
    "red-test-observed", "hand-running", "hand-handoff", "primary-verifying", "evidence-ready",
    "scale-running", "review-passed", "scale-waived", "accepted", "remediation", "rejected",
  ]);
  if (handGatePhases.has(phase) && !hasRedEvidence && !hasTddWaiver) return false;
  return true;
}

function validAudit(value: unknown, workItemId: string, roadmapIds: Set<string>): boolean {
  if (!isObject(value)
    || (value.kind !== "phase" && value.kind !== "roadmap")
    || value.workItemId !== workItemId
    || !isActor(value.actor)
    || !nonEmptyString(value.timestamp)
    || !nonEmptyString(value.reason)
    || !nonEmptyString(value.reference)
    || !nonEmptyString(value.from)
    || !nonEmptyString(value.to)) return false;
  if (value.kind === "phase") {
    return isPhase(value.from) && isPhase(value.to) && value.roadmapItemId === undefined;
  }
  return nonEmptyString(value.roadmapItemId)
    && roadmapIds.has(value.roadmapItemId)
    && isStatus(value.from)
    && isStatus(value.to);
}

function latestPhaseAudit(record: WorkflowRecord) {
  for (let index = record.history.length - 1; index >= 0; index -= 1) {
    const entry = record.history[index];
    if (entry?.kind === "phase") return entry;
  }
  return undefined;
}

function latestRoadmapAudit(record: WorkflowRecord, itemId: string) {
  for (let index = record.history.length - 1; index >= 0; index -= 1) {
    const entry = record.history[index];
    if (entry?.kind === "roadmap" && entry.roadmapItemId === itemId) return entry;
  }
  return undefined;
}

/** Validate a canonical record. Invalid/conflicting state is represented as a
 * blocked recovery record rather than being treated as usable state. */
export function validateWorkflowRecord(record: unknown): WorkflowValidation {
  const invalid = (reason: string): InvalidWorkflowRecord => ({
    ok: false,
    blocked: blockedRecord(record, reason),
    reason,
  });
  if (!isObject(record)) return invalid("Workflow record is not an object; blocked.");
  if (!nonEmptyString(record.workItemId)) return invalid("Workflow record has no work-item identity; blocked.");
  if (!CLASSIFICATIONS.has(record.classification as string)) return invalid("Unknown workflow classification; blocked.");
  if (!nonEmptyString(record.goal)
    || !isStringArray(record.requirementIds)
    || !isStringArray(record.nonGoals)
    || !isStringArray(record.expectedPaths)
    || !isPhase(record.phase)
    || !Array.isArray(record.roadmap)
    || !Array.isArray(record.history)
    || !nonEmptyString(record.nextGate)
    || !isStringArray(record.blockers)
    || !isStringArray(record.residualRisks)
    || !Array.isArray(record.evidence)) {
    return invalid("Workflow record has malformed required state; blocked.");
  }
  // Schema-v1 drafts predate numbered functional requirements. Keep those
  // records recoverable, while every newly authored packet and every
  // post-draft phase remains strict about FR-N identities.
  const requiresNumberedRequirements = record.functionalRequirements !== undefined
    || PACKET_FIELDS.some((field) => record[field] !== undefined)
    || PACKET_REQUIRED_PHASES.has(record.phase);
  if (!record.requirementIds.every(nonEmptyString)
    || (requiresNumberedRequirements && !record.requirementIds.every((id) => REQUIREMENT_ID.test(id)))
    || record.requirementIds.length !== new Set(record.requirementIds).size
    || !record.nonGoals.every((entry) => boundedPacketString(entry, 4 * 1024))
    || !record.expectedPaths.every((entry) => boundedPacketString(entry, 4 * 1024))
    || !record.blockers.every((entry) => typeof entry === "string")
    || !record.residualRisks.every((entry) => typeof entry === "string")) {
    return invalid("Workflow record contains malformed or unnumbered requirement state; blocked.");
  }
  const declaredRequirementIds = record.requirementIds as string[];
  if ((record.functionalRequirements !== undefined && !validFunctionalRequirements(record.functionalRequirements, declaredRequirementIds))
    || (record.unresolvedDecisions !== undefined && !isStringArray(record.unresolvedDecisions))
    || (record.redTestReference !== undefined && typeof record.redTestReference !== "string")
    || (record.tddWaiverReference !== undefined && typeof record.tddWaiverReference !== "string")
    || (record.scaleVerdict !== undefined && typeof record.scaleVerdict !== "string")
    || (record.scaleWaiverReference !== undefined && typeof record.scaleWaiverReference !== "string")
    || (record.changedScopeSummary !== undefined && typeof record.changedScopeSummary !== "string")
    || (record.latestCapsuleReference !== undefined && typeof record.latestCapsuleReference !== "string")
    || (record.packetAuthor !== undefined && record.packetAuthor !== "Primary")
    || (record.acceptanceChecks !== undefined && !packetStringArray(record.acceptanceChecks))
    || (record.authorityConstraints !== undefined && !packetStringArray(record.authorityConstraints))
    || (record.redTestEvidence !== undefined && !isObject(record.redTestEvidence))
    || (record.tddWaiver !== undefined && !isObject(record.tddWaiver))) {
    return invalid("Workflow record contains malformed packet, functional requirements, red-test, or waiver metadata; blocked.");
  }
  const hasPacketField = PACKET_FIELDS.some((field) => record[field] !== undefined);
  if (hasPacketField && !(record.phase === "draft" && record.functionalRequirements === undefined) && !validPacketMetadata(record)) {
    return invalid("Workflow specification packet requires Primary author, complete functional requirements, acceptance checks, and authority constraints; blocked.");
  }
  if (PACKET_REQUIRED_PHASES.has(record.phase) && !validPacketMetadata(record)) {
    return invalid("Workflow phase requires a complete Primary-authored specification packet; blocked.");
  }
  const items = record.roadmap as WorkflowRoadmapItem[];
  const roadmapIds = new Set<string>();
  for (const item of items) {
    if (!isRoadmapItem(item)) return invalid("Workflow record contains a malformed roadmap item; blocked.");
    if (roadmapIds.has(item.id)) return invalid("Workflow record contains duplicate roadmap state; blocked.");
    roadmapIds.add(item.id);
    if (requiresNumberedRequirements
      && (item.requirementIds.length === 0 || item.requirementIds.length !== new Set(item.requirementIds).size)) {
      return invalid("Workflow roadmap contains empty or duplicate requirement links; blocked.");
    }
    if (!item.requirementIds.every((id) => (!requiresNumberedRequirements || REQUIREMENT_ID.test(id)) && declaredRequirementIds.includes(id))) {
      return invalid("Workflow roadmap references an undeclared requirement; blocked.");
    }
  }
  const coveredRequirements = new Set(items.flatMap((item) => item.requirementIds));
  if (declaredRequirementIds.some((id) => !coveredRequirements.has(id))) {
    return invalid("Workflow roadmap does not cover every declared requirement; blocked.");
  }
  for (const evidence of record.evidence) {
    if (!isObject(evidence) || !nonEmptyString(evidence.id)) return invalid("Workflow record contains malformed evidence state; blocked.");
    for (const value of Object.values(evidence)) {
      if (value !== undefined && typeof value !== "string") return invalid("Workflow record contains malformed evidence metadata; blocked.");
    }
  }
  let priorPhase: string | undefined;
  const priorRoadmap = new Map<string, string>();
  for (const entry of record.history) {
    if (!validAudit(entry, record.workItemId, roadmapIds)) return invalid("Workflow record contains malformed transition audit state; blocked.");
    if (entry.kind === "phase") {
      if (!PHASE_TRANSITIONS[entry.from as WorkflowPhase].includes(entry.to as WorkflowPhase)) return invalid("Workflow history contains an invalid phase transition; blocked.");
      if (priorPhase !== undefined && priorPhase !== entry.from) return invalid("Workflow history contains conflicting phase ancestry; blocked.");
      priorPhase = entry.to;
      if (PRIMARY_ONLY_PHASES.has(entry.to as WorkflowPhase) && entry.actor !== "Primary") {
        return invalid("Only Primary can authorize this workflow phase; blocked.");
      }
    } else {
      if (!ROADMAP_TRANSITIONS[entry.from as RoadmapStatus].includes(entry.to as RoadmapStatus)) return invalid("Workflow history contains an invalid roadmap transition; blocked.");
      const prior = priorRoadmap.get(entry.roadmapItemId);
      if (prior !== undefined && prior !== entry.from) return invalid("Workflow history contains conflicting roadmap ancestry; blocked.");
      priorRoadmap.set(entry.roadmapItemId, entry.to);
      if (PRIMARY_ONLY_ROADMAP_STATUSES.has(entry.to as RoadmapStatus) && entry.actor !== "Primary") {
        return invalid("Only Primary can verify or waive roadmap state; blocked.");
      }
    }
  }
  const canonical = record as unknown as WorkflowRecord;
  const phaseAudit = latestPhaseAudit(canonical);
  if (canonical.phase !== "draft" && (!phaseAudit || phaseAudit.to !== canonical.phase)) {
    return invalid("Non-draft workflow phase requires a matching latest audit; blocked.");
  }
  if (phaseAudit && phaseAudit.to !== canonical.phase) return invalid("Workflow phase conflicts with its latest audit; blocked.");
  if (phaseAudit && PRIMARY_ONLY_PHASES.has(phaseAudit.to as WorkflowPhase) && phaseAudit.actor !== "Primary") {
    return invalid("Only Primary can authorize the current workflow phase; blocked.");
  }
  if (canonical.phase === "accepted" && items.some((item) => item.status !== "verified" && item.status !== "waived")) {
    return invalid("Accepted workflow state has unsettled roadmap items; blocked.");
  }
  for (const item of items) {
    const audit = latestRoadmapAudit(canonical, item.id);
    if (item.status !== "pending" && (!audit || audit.to !== item.status)) {
      return invalid(`Roadmap item ${item.id} requires a matching latest audit; blocked.`);
    }
    if (audit && audit.to !== item.status) return invalid(`Roadmap item ${item.id} conflicts with its latest audit; blocked.`);
    if (audit && PRIMARY_ONLY_ROADMAP_STATUSES.has(audit.to as RoadmapStatus) && audit.actor !== "Primary") {
      return invalid(`Only Primary can verify or waive roadmap item ${item.id}; blocked.`);
    }
    if (item.status === "waived" && (!audit || audit.to !== "waived" || audit.actor !== "Primary" || !nonEmptyString(audit.reason) || !nonEmptyString(audit.reference))) {
      return invalid(`Roadmap item ${item.id} has an invalid waiver; blocked.`);
    }
  }
  return { ok: true, record: cloneRecord(canonical) };
}

function requireValidRecord(record: WorkflowRecord): WorkflowRecord {
  const validation = validateWorkflowRecord(record);
  if (!validation.ok) throw new Error(validation.reason);
  return validation.record;
}

function validAuditInput(input: unknown): input is PhaseTransitionInput | RoadmapTransitionInput {
  return isObject(input)
    && isActor(input.actor)
    && nonEmptyString(input.timestamp)
    && nonEmptyString(input.reason)
    && nonEmptyString(input.reference)
    && nonEmptyString(input.to);
}

/** Apply one normative workflow phase transition without mutating the input. */
export function applyPhaseTransition(record: WorkflowRecord, transition: PhaseTransitionInput): WorkflowRecord {
  const current = requireValidRecord(record);
  if (!validAuditInput(transition as unknown)) {
    const malformed = transition as unknown as Record<string, unknown>;
    if (!nonEmptyString(malformed.reason)) throw new Error("A transition reason is required.");
    if (!nonEmptyString(malformed.reference)) throw new Error("A transition reference is required.");
    throw new Error("Malformed phase transition audit.");
  }
  if (!isPhase(transition.to)) throw new Error("Unknown workflow phase transition target.");
  const allowed = PHASE_TRANSITIONS[current.phase];
  if (!allowed.includes(transition.to)) {
    throw new Error(`Invalid workflow phase transition ${current.phase} -> ${transition.to}.`);
  }
  if (PRIMARY_ONLY_PHASES.has(transition.to) && transition.actor !== "Primary") {
    throw new Error("Only Primary has authority for this workflow transition.");
  }
  if (transition.to === "accepted" && current.roadmap.some((item) => item.status !== "verified" && item.status !== "waived")) {
    throw new Error("Workflow cannot be accepted until every roadmap item is verified or validly waived.");
  }
  const next = cloneRecord(current);
  next.phase = transition.to;
  next.history.push({
    kind: "phase",
    workItemId: current.workItemId,
    from: current.phase,
    to: transition.to,
    actor: transition.actor,
    timestamp: transition.timestamp,
    reason: transition.reason,
    reference: transition.reference,
  });
  const validation = validateWorkflowRecord(next);
  if (!validation.ok) throw new Error(validation.reason);
  return validation.record;
}

/** Apply one normative roadmap status transition without mutating the input. */
export function applyRoadmapTransition(record: WorkflowRecord, itemId: string, transition: RoadmapTransitionInput): WorkflowRecord {
  const current = requireValidRecord(record);
  if (current.phase === "accepted" || current.phase === "rejected") {
    throw new Error("Terminal workflow state cannot mutate roadmap state.");
  }
  if (!nonEmptyString(itemId)) throw new Error("A roadmap item ID is required.");
  if (!validAuditInput(transition as unknown)) {
    const malformed = transition as unknown as Record<string, unknown>;
    if (!nonEmptyString(malformed.reason)) throw new Error("A transition reason is required.");
    if (!nonEmptyString(malformed.reference)) throw new Error("A transition reference is required.");
    throw new Error("Malformed roadmap transition audit.");
  }
  if (!isStatus(transition.to)) throw new Error("Unknown roadmap status transition target.");
  const itemIndex = current.roadmap.findIndex((item) => item.id === itemId);
  if (itemIndex < 0) throw new Error(`Unknown roadmap item ${itemId}.`);
  const item = current.roadmap[itemIndex]!;
  const allowed = ROADMAP_TRANSITIONS[item.status];
  if (!allowed.includes(transition.to)) throw new Error(`Invalid roadmap transition ${item.status} -> ${transition.to}.`);
  if ((transition.to === "verified" || transition.to === "waived") && transition.actor !== "Primary") {
    throw new Error("Only Primary can verify or waive roadmap items.");
  }
  const next = cloneRecord(current);
  next.roadmap[itemIndex] = { ...next.roadmap[itemIndex]!, status: transition.to };
  next.history.push({
    kind: "roadmap",
    workItemId: current.workItemId,
    roadmapItemId: itemId,
    from: item.status,
    to: transition.to,
    actor: transition.actor,
    timestamp: transition.timestamp,
    reason: transition.reason,
    reference: transition.reference,
  });
  const validation = validateWorkflowRecord(next);
  if (!validation.ok) throw new Error(validation.reason);
  return validation.record;
}

export interface ChecklistItemView {
  id: string;
  title: string;
  status: RoadmapStatus;
  requirementIds: readonly string[];
}

export interface ChecklistView {
  workItemId: string;
  phase: WorkflowPhase;
  nextGate: string;
  items: readonly ChecklistItemView[];
}

/** Return a disposable, deeply immutable rendering of canonical state. */
export function deriveChecklistView(record: WorkflowRecord): Readonly<ChecklistView> {
  const current = requireValidRecord(record);
  const items = current.roadmap.map((item) => Object.freeze({
    id: item.id,
    title: item.title,
    status: item.status,
    requirementIds: Object.freeze([...item.requirementIds]),
  }));
  return Object.freeze({
    workItemId: current.workItemId,
    phase: current.phase,
    nextGate: current.nextGate,
    items: Object.freeze(items),
  });
}
