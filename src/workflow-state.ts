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
  type BoundedEvidenceReference,
  type IndependentCheck,
  type PrimaryInspection,
  type ScaleFinding,
  type ScaleReview,
  type ScaleWaiver,
  type ScaleAdmission,
  type Remediation,
  MAX_REMEDIATION_ATTEMPTS,
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
const WORKFLOW_RECORD_KEYS = new Set([
  "workItemId", "classification", "goal", "requirementIds", "functionalRequirements", "nonGoals", "expectedPaths",
  "phase", "roadmap", "history", "nextGate", "blockers", "residualRisks", "evidence", "packetAuthor",
  "acceptanceChecks", "authorityConstraints", "redTestEvidence", "tddWaiver", "unresolvedDecisions", "redTestReference",
  "tddWaiverReference", "scaleVerdict", "scaleWaiverReference", "changedScopeSummary", "latestCapsuleReference",
  "primaryInspection", "scaleAdmission", "scaleReview", "scaleWaiver", "remediation",
]);

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
  /** Trusted controller-supplied correction paths; direct callers fall back to packet paths. */
  correctionScope?: string[];
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
    "primaryInspection",
    "scaleAdmission",
    "scaleReview",
    "scaleWaiver",
    "remediation",
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
      } else if (key === "primaryInspection" && isObject(value)) {
        const objectValue = value as Record<string, unknown>;
        copied = {
          ...objectValue,
          materiallyChangedPaths: Array.isArray(objectValue.materiallyChangedPaths) ? [...objectValue.materiallyChangedPaths] : objectValue.materiallyChangedPaths,
          outOfScopeChanges: Array.isArray(objectValue.outOfScopeChanges) ? objectValue.outOfScopeChanges.map((entry) => isObject(entry) ? { ...entry } : entry) : objectValue.outOfScopeChanges,
          independentChecks: Array.isArray(objectValue.independentChecks) ? objectValue.independentChecks.map((entry) => isObject(entry) ? { ...entry, ...(isObject(entry.evidenceReference) ? { evidenceReference: { ...entry.evidenceReference } } : {}) } : entry) : objectValue.independentChecks,
          ...(isObject(objectValue.statusReference) ? { statusReference: { ...objectValue.statusReference } } : {}),
          ...(isObject(objectValue.completeDiffReference) ? { completeDiffReference: { ...objectValue.completeDiffReference } } : {}),
        };
      } else if (key === "scaleAdmission" && isObject(value)) {
        copied = { ...(value as Record<string, unknown>) };
      } else if (key === "scaleReview" && isObject(value)) {
        const objectValue = value as Record<string, unknown>;
        copied = {
          ...objectValue,
          evidenceReferences: Array.isArray(objectValue.evidenceReferences) ? objectValue.evidenceReferences.map((entry) => isObject(entry) ? { ...entry } : entry) : objectValue.evidenceReferences,
          findings: Array.isArray(objectValue.findings) ? objectValue.findings.map((entry) => isObject(entry) ? { ...entry, ...(isObject(entry.evidenceReference) ? { evidenceReference: { ...entry.evidenceReference } } : {}) } : entry) : objectValue.findings,
        };
      } else if (key === "scaleWaiver" && isObject(value)) {
        const objectValue = value as Record<string, unknown>;
        copied = {
          ...objectValue,
          scope: Array.isArray(objectValue.scope) ? [...objectValue.scope] : objectValue.scope,
          ...(isObject(objectValue.compensatingEvidence) ? { compensatingEvidence: { ...objectValue.compensatingEvidence } } : {}),
          ...(isObject(objectValue.policyReference) ? { policyReference: { ...objectValue.policyReference } } : {}),
        };
      } else if (key === "remediation" && isObject(value)) {
        const objectValue = value as Record<string, unknown>;
        copied = {
          ...objectValue,
          sourceFindingIds: Array.isArray(objectValue.sourceFindingIds) ? [...objectValue.sourceFindingIds] : objectValue.sourceFindingIds,
          correctionScope: Array.isArray(objectValue.correctionScope) ? [...objectValue.correctionScope] : objectValue.correctionScope,
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
    && value.every((entry) => boundedPacketString(entry, 4 * 1024))
    && new Set(value).size === value.length;
}

function validArtifactReference(value: unknown): boolean {
  if (typeof value === "string") return boundedPacketString(value, 4 * 1024);
  const allowed = new Set(["id", "kind", "label", "source", "sha256", "bytes", "createdAt", "expiresAt"]);
  if (!isObject(value) || !hasOnlyKeys(value, allowed) || !boundedPacketString(value.id, 256)) return false;
  return Object.entries(value).every(([key, entry]) => {
    if (!allowed.has(key) || entry === undefined) return false;
    if (key === "bytes") return typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 && entry <= 2 * 1024 * 1024;
    if (key === "sha256") return SHA256_HEX.test(typeof entry === "string" ? entry : "");
    return boundedPacketString(entry, key === "source" ? 4 * 1024 : 1024);
  });
}

const INSPECTION_KEYS = new Set([
  "id", "actor", "inspectedAt", "statusReference", "completeDiffReference", "diffFingerprint",
  "materiallyChangedPaths", "outOfScopeChanges", "independentChecks", "residualRisks",
]);
const OUT_OF_SCOPE_KEYS = new Set(["path", "disposition"]);
const CHECK_KEYS = new Set(["id", "command", "result", "evidenceReference"]);
const REVIEW_KEYS = new Set([
  "id", "runId", "admissionId", "reviewer", "completedAt", "freshContext", "diffFingerprint",
  "evidenceReferences", "verdict", "findings", "residualUncertainty",
]);
const FINDING_KEYS = new Set(["id", "classification", "evidenceReference", "summary"]);
const SCALE_ADMISSION_KEYS = new Set(["admissionId", "nonce", "workItemId", "inspectionId", "diffFingerprint", "admittedAt", "boundRunId"]);
const SCALE_WAIVER_KEYS = new Set([
  "id", "item", "basis", "actor", "approver", "date", "scope", "reason", "riskLimit",
  "compensatingEvidence", "userMessageEntryId", "policyReference", "owner", "expiresAt", "reviewAt",
]);
const REMEDIATION_KEYS = new Set([
  "id", "sourceReviewId", "sourceFindingIds", "correctionScope", "attempt", "maxAttempts", "active", "createdAt",
]);
const SHA256_GATE = /^[0-9a-f]{64}$/u;

function validBoundedGateText(value: unknown, maximum = 8 * 1024): value is string {
  return boundedPacketString(value, maximum);
}

function validGateReference(value: unknown): boolean {
  if (!validArtifactReference(value)) return false;
  if (typeof value === "string" && /^(?:none|n\/a|na|unknown|tbd)$/iu.test(value.trim())) return false;
  if (!isObject(value) || value.expiresAt === undefined) return true;
  // Structural validation deliberately does not compare expiry to wall clock:
  // accepted terminal records remain valid after temporary artifacts expire.
  // Live freshness is checked at Scale admission/review and final accept.
  return canonicalUtcDate(value.expiresAt);
}

function validCheckoutRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && validBoundedGateText(value, 4 * 1024)
    && !value.startsWith("/")
    && !value.split(/[\\/]/u).includes("..")
    && value !== ".";
}

function referenceIdentity(value: string | BoundedEvidenceReference): string {
  return typeof value === "string" ? value : value.id;
}

function validUniqueReferences(value: unknown, minimum = 1): value is Array<string | BoundedEvidenceReference> {
  if (!Array.isArray(value) || value.length < minimum || value.length > 64) return false;
  const identities = value.map((entry) => {
    if (!validGateReference(entry)) return undefined;
    return referenceIdentity(entry as string | BoundedEvidenceReference);
  });
  return identities.every((entry): entry is string => entry !== undefined)
    && new Set(identities).size === identities.length;
}

function validIndependentCheck(value: unknown): value is IndependentCheck {
  return isObject(value)
    && hasOnlyKeys(value, CHECK_KEYS)
    && validBoundedGateText(value.id, 256)
    && validBoundedGateText(value.command, 8 * 1024)
    && (value.result === "passed" || value.result === "failed")
    && validGateReference(value.evidenceReference);
}

function validPrimaryInspection(value: unknown, acceptanceChecks?: readonly string[]): value is PrimaryInspection {
  if (!isObject(value)
    || !hasOnlyKeys(value, INSPECTION_KEYS)
    || !validBoundedGateText(value.id, 256)
    || value.actor !== "Primary"
    || !canonicalUtcDate(value.inspectedAt)
    || !validGateReference(value.statusReference)
    || !validGateReference(value.completeDiffReference)
    || !SHA256_GATE.test(typeof value.diffFingerprint === "string" ? value.diffFingerprint : "")
    || !Array.isArray(value.materiallyChangedPaths)
    || value.materiallyChangedPaths.length > 64
    || !value.materiallyChangedPaths.every(validCheckoutRelativePath)
    || new Set(value.materiallyChangedPaths).size !== value.materiallyChangedPaths.length
    || !Array.isArray(value.outOfScopeChanges)
    || value.outOfScopeChanges.length > 64
    || !value.outOfScopeChanges.every((entry) => isObject(entry)
      && hasOnlyKeys(entry, OUT_OF_SCOPE_KEYS)
      && validCheckoutRelativePath(entry.path)
      && validBoundedGateText(entry.disposition, 4 * 1024))
    || !Array.isArray(value.independentChecks)
    || value.independentChecks.length === 0
    || value.independentChecks.length > 64
    || !value.independentChecks.every(validIndependentCheck)
    || !Array.isArray(value.residualRisks)
    || value.residualRisks.length > 64
    || !value.residualRisks.every((entry) => validBoundedGateText(entry, 4 * 1024))) return false;
  const checks = value.independentChecks as IndependentCheck[];
  const outOfScopeChanges = value.outOfScopeChanges as Array<{ path: string; disposition: string }>;
  if (new Set(checks.map((check) => check.id)).size !== checks.length) return false;
  if (new Set(checks.map((check) => check.command)).size !== checks.length) return false;
  if (new Set(outOfScopeChanges.map((entry) => entry.path)).size !== outOfScopeChanges.length) return false;
  // Every recorded check is required evidence. A passing check cannot mask a
  // failed companion check, and packet checks must map one-to-one to command
  // strings without substitution or omission.
  if (!checks.every((check) => check.result === "passed")) return false;
  if (acceptanceChecks !== undefined) {
    if (!Array.isArray(acceptanceChecks)
      || acceptanceChecks.length === 0
      || !acceptanceChecks.every((command) => typeof command === "string")
      || new Set(acceptanceChecks).size !== acceptanceChecks.length
      || checks.length !== acceptanceChecks.length
      || !checks.every((check) => acceptanceChecks.includes(check.command))
      || !acceptanceChecks.every((command) => checks.some((check) => check.command === command))) return false;
  }
  return true;
}

function validScaleAdmission(value: unknown, workItemId: string, inspection?: PrimaryInspection): value is ScaleAdmission {
  if (!isObject(value)
    || !hasOnlyKeys(value, SCALE_ADMISSION_KEYS)
    || !validBoundedGateText(value.admissionId, 256)
    || !validBoundedGateText(value.nonce, 128)
    || !/^[0-9a-f]{64}$/u.test(value.nonce)
    || value.admissionId !== `scale-admission-${value.nonce}`
    || value.workItemId !== workItemId
    || !validBoundedGateText(value.inspectionId, 256)
    || !SHA256_GATE.test(typeof value.diffFingerprint === "string" ? value.diffFingerprint : "")
    || !canonicalUtcDate(value.admittedAt)
    || (value.boundRunId !== undefined && !validBoundedGateText(value.boundRunId, 256))) return false;
  if (inspection && (value.inspectionId !== inspection.id || value.diffFingerprint !== inspection.diffFingerprint)) return false;
  return true;
}

export function validateScaleAdmission(value: unknown, workItemId: string, inspection?: PrimaryInspection): value is ScaleAdmission {
  return validScaleAdmission(value, workItemId, inspection);
}

function validScaleFinding(value: unknown): value is ScaleFinding {
  return isObject(value)
    && hasOnlyKeys(value, FINDING_KEYS)
    && validBoundedGateText(value.id, 256)
    && (value.classification === "blocker" || value.classification === "fix-now" || value.classification === "optional")
    && validGateReference(value.evidenceReference)
    && validBoundedGateText(value.summary, 8 * 1024);
}

function validScaleReview(value: unknown, inspection: PrimaryInspection | undefined): value is ScaleReview {
  if (!isObject(value)
    || !hasOnlyKeys(value, REVIEW_KEYS)
    || !validBoundedGateText(value.id, 256)
    || !validBoundedGateText(value.runId, 256)
    || !validBoundedGateText(value.admissionId, 256)
    || value.reviewer !== "Scale"
    || !canonicalUtcDate(value.completedAt)
    || value.freshContext !== true
    || !SHA256_GATE.test(typeof value.diffFingerprint === "string" ? value.diffFingerprint : "")
    || !validUniqueReferences(value.evidenceReferences, 1)
    || (value.verdict !== "pass" && value.verdict !== "changes-required")
    || !Array.isArray(value.findings)
    || value.findings.length > 64
    || !value.findings.every(validScaleFinding)
    || !validBoundedGateText(value.residualUncertainty, 8 * 1024)) return false;
  if (new Set(value.findings.map((finding) => finding.id)).size !== value.findings.length) return false;
  const blocking = value.findings.some((finding) => finding.classification === "blocker" || finding.classification === "fix-now");
  if (value.verdict === "pass" && blocking) return false;
  if (value.verdict === "changes-required" && !blocking) return false;
  if (!inspection || value.diffFingerprint !== inspection.diffFingerprint) return false;
  const evidence = new Set(value.evidenceReferences.map((entry) => referenceIdentity(entry)));
  // A passing review must prove every Primary evidence seam. A
  // changes-required review may be intentionally narrow (the finding itself
  // is the handoff), but must still be bound to the complete diff it found.
  const required = value.verdict === "pass"
    ? [inspection.statusReference, inspection.completeDiffReference,
      ...inspection.independentChecks.map((check) => check.evidenceReference),
      ...value.findings.map((finding) => finding.evidenceReference)].map(referenceIdentity)
    : [inspection.completeDiffReference, ...value.findings.map((finding) => finding.evidenceReference)].map(referenceIdentity);
  return required.every((reference) => evidence.has(reference));
}

function broadScaleScope(scope: string): boolean {
  return /(?:^|\b)(?:all|any|everything|entire|whole|unbounded|unlimited)(?:\b|$)|\b(?:all|entire|whole)\s+(?:changes|work|project|repository|checkout|codebase|scope)\b/iu.test(scope);
}

function validScaleWaiver(value: unknown, workItemId: string): value is ScaleWaiver {
  if (!isObject(value)
    || !hasOnlyKeys(value, SCALE_WAIVER_KEYS)
    || !validBoundedGateText(value.id, 256)
    || value.item !== workItemId
    || (value.basis !== "user-explicit" && value.basis !== "policy")
    || value.actor !== "Primary"
    || value.approver !== "Primary"
    || !canonicalUtcDate(value.date)
    || !validBoundedGateText(value.reason, 8 * 1024)
    || !validBoundedGateText(value.riskLimit, 4 * 1024)
    || !validGateReference(value.compensatingEvidence)) return false;
  const scope = value.scope;
  const scopeItems = typeof scope === "string" ? [scope] : scope;
  if (!Array.isArray(scopeItems) || scopeItems.length === 0 || scopeItems.length > 64
    || !scopeItems.every((entry) => validBoundedGateText(entry, 4 * 1024))
    || scopeItems.some(broadScaleScope)) return false;
  if (/time\s*pressure|deadline|capacity|convenience|no\s*time|urgent/iu.test(value.reason)) return false;
  const compensationValue = value.compensatingEvidence as string | BoundedEvidenceReference;
  const compensation = typeof compensationValue === "string"
    ? compensationValue
    : compensationValue.id;
  if (/^(?:none|n\/a|na|no(?:ne)?(?:\s+provided)?|tbd)$/iu.test(compensation.trim())) return false;
  if (value.basis === "user-explicit") {
    if (!validBoundedGateText(value.userMessageEntryId, 256)
      || value.policyReference !== undefined || value.owner !== undefined
      || value.expiresAt !== undefined || value.reviewAt !== undefined) return false;
  } else {
    if (value.userMessageEntryId !== undefined || !validGateReference(value.policyReference)
      || !validBoundedGateText(value.owner, 1 * 1024)
      || (!canonicalUtcDate(value.expiresAt) && !canonicalUtcDate(value.reviewAt))) return false;
    const date = Date.parse(value.date);
    const expiryValue = value.expiresAt ?? value.reviewAt;
    const reviewValue = value.reviewAt ?? value.expiresAt;
    if (!canonicalUtcDate(expiryValue) || !canonicalUtcDate(reviewValue)) return false;
    const expires = Date.parse(expiryValue);
    const review = Date.parse(reviewValue);
    if (!Number.isFinite(date) || !Number.isFinite(expires) || !Number.isFinite(review)
      || expires <= date || review <= date) return false;
  }
  return true;
}

function canonicalUtcDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validRemediation(value: unknown): value is Remediation {
  return isObject(value)
    && hasOnlyKeys(value, REMEDIATION_KEYS)
    && validBoundedGateText(value.id, 256)
    && validBoundedGateText(value.sourceReviewId, 256)
    && Array.isArray(value.sourceFindingIds)
    && value.sourceFindingIds.length > 0
    && value.sourceFindingIds.length <= 64
    && value.sourceFindingIds.every((entry) => validBoundedGateText(entry, 256))
    && new Set(value.sourceFindingIds).size === value.sourceFindingIds.length
    && Array.isArray(value.correctionScope)
    && value.correctionScope.length > 0
    && value.correctionScope.length <= 64
    && value.correctionScope.every(validCheckoutRelativePath)
    && new Set(value.correctionScope).size === value.correctionScope.length
    && Number.isSafeInteger(value.attempt)
    && (value.attempt as number) >= 1
    && (value.attempt as number) <= MAX_REMEDIATION_ATTEMPTS
    && value.maxAttempts === MAX_REMEDIATION_ATTEMPTS
    && typeof value.active === "boolean"
    && canonicalUtcDate(value.createdAt);
}

export function validatePrimaryInspection(value: unknown, acceptanceChecks?: readonly string[]): value is PrimaryInspection {
  return validPrimaryInspection(value, acceptanceChecks);
}

export function validateScaleReview(value: unknown, inspection?: PrimaryInspection): value is ScaleReview {
  return validScaleReview(value, inspection);
}

export function validateScaleWaiver(value: unknown, workItemId: string): value is ScaleWaiver {
  return validScaleWaiver(value, workItemId);
}

export function validateRemediation(value: unknown): value is Remediation {
  return validRemediation(value);
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
  if (Object.keys(record).some((key) => !WORKFLOW_RECORD_KEYS.has(key))) return invalid("Workflow record contains unknown state; blocked.");
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
    || (record.tddWaiver !== undefined && !isObject(record.tddWaiver))
    || (record.primaryInspection !== undefined && !isObject(record.primaryInspection))
    || (record.scaleReview !== undefined && !isObject(record.scaleReview))
    || (record.scaleWaiver !== undefined && !isObject(record.scaleWaiver))
    || (record.remediation !== undefined && !isObject(record.remediation))) {
    return invalid("Workflow record contains malformed packet, functional requirements, red-test, or waiver metadata; blocked.");
  }
  const hasPacketField = PACKET_FIELDS.some((field) => record[field] !== undefined);
  if (hasPacketField && !(record.phase === "draft" && record.functionalRequirements === undefined) && !validPacketMetadata(record)) {
    return invalid("Workflow specification packet requires Primary author, complete functional requirements, acceptance checks, and authority constraints; blocked.");
  }
  if (PACKET_REQUIRED_PHASES.has(record.phase) && !validPacketMetadata(record)) {
    return invalid("Workflow phase requires a complete Primary-authored specification packet; blocked.");
  }
  // Phase 3 gate records are optional only before the corresponding gate. Once
  // a record claims evidence-ready/review-passed/waived/accepted authority,
  // every current record must be complete and internally linked.
  const inspection = record.primaryInspection;
  if (inspection !== undefined && !validPrimaryInspection(inspection, record.acceptanceChecks)) {
    return invalid("Primary inspection is malformed, incomplete, or does not cover every packet acceptance check; blocked.");
  }
  const review = record.scaleReview;
  if (review !== undefined && !validScaleReview(review, inspection)) {
    return invalid("Scale review is stale, summary-only, malformed, or not bound to the current inspection; blocked.");
  }
  const scaleAdmission = record.scaleAdmission;
  if (scaleAdmission !== undefined && !validScaleAdmission(scaleAdmission, record.workItemId, inspection)) {
    return invalid("Scale admission is malformed, stale, or not bound to the current Primary inspection; blocked.");
  }
  if (scaleAdmission !== undefined && !["scale-running", "review-passed", "remediation", "accepted"].includes(record.phase)) {
    return invalid("A Scale admission is current only while Scale is running or its bound passing review remains authoritative; blocked.");
  }
  const scaleWaiver = record.scaleWaiver;
  if (scaleWaiver !== undefined && !validScaleWaiver(scaleWaiver, record.workItemId)) {
    return invalid("Scale waiver is malformed, broad, uncompensated, or not bound to this work item; blocked.");
  }
  const remediation = record.remediation;
  if (remediation !== undefined && !validRemediation(remediation)) {
    return invalid("Remediation record is malformed or exceeds the bounded correction policy; blocked.");
  }
  if (["evidence-ready", "scale-running", "review-passed", "scale-waived", "accepted"].includes(record.phase)
    && inspection === undefined) {
    return invalid("Evidence-ready workflow state requires a complete current Primary inspection; blocked.");
  }
  if (["review-passed", "accepted"].includes(record.phase) && review === undefined && scaleWaiver === undefined) {
    return invalid("Review-passed workflow state requires a current completed Scale review; blocked.");
  }
  if (["scale-running", "review-passed", "remediation", "accepted"].includes(record.phase) && review !== undefined
    && (!scaleAdmission?.boundRunId
      || review.admissionId !== scaleAdmission.admissionId
      || review.runId !== scaleAdmission.boundRunId)) {
    return invalid("Passing Scale review is not durably bound to its exact admission and run; blocked.");
  }
  if (record.phase === "scale-waived" && scaleWaiver === undefined) {
    return invalid("Scale-waived workflow state requires a current bounded Scale waiver; blocked.");
  }
  if (record.phase === "accepted" && review === undefined && scaleWaiver === undefined) {
    return invalid("Accepted workflow state requires a current Scale review or bounded Scale waiver; blocked.");
  }
  if (review === undefined && record.scaleVerdict !== undefined
    && ["review-passed", "accepted", "remediation"].includes(record.phase)) {
    return invalid("Scale verdict has no current review evidence; blocked.");
  }
  if (review !== undefined && record.scaleVerdict !== undefined && record.scaleVerdict !== review.verdict) {
    return invalid("Scale verdict does not match its current review; blocked.");
  }
  if (scaleWaiver !== undefined && record.scaleWaiverReference !== undefined && record.scaleWaiverReference !== scaleWaiver.id) {
    return invalid("Scale-waiver reference is stale or does not identify the current waiver; blocked.");
  }
  if (["scale-waived", "accepted"].includes(record.phase)
    && scaleWaiver !== undefined && record.scaleWaiverReference !== scaleWaiver.id) {
    return invalid("Scale-waived workflow requires a matching current waiver reference; blocked.");
  }
  if (["scale-waived", "accepted"].includes(record.phase)
    && scaleWaiver === undefined && record.scaleWaiverReference !== undefined) {
    return invalid("Scale-waiver reference has no current waiver evidence; blocked.");
  }
  if (remediation !== undefined && review !== undefined && remediation.sourceReviewId !== review.id && record.phase === "remediation") {
    return invalid("Remediation is not linked to the current Scale review; blocked.");
  }
  if (record.phase === "remediation" && remediation === undefined) {
    return invalid("Remediation phase requires one active bounded correction; blocked.");
  }
  if (record.phase === "remediation" && review === undefined) {
    return invalid("Remediation phase requires its current linked Scale review; blocked.");
  }
  if (record.phase === "remediation" && remediation !== undefined && remediation.active !== true) {
    return invalid("Remediation phase requires one active bounded correction; blocked.");
  }
  if (remediation !== undefined) {
    const packetPaths = new Set(record.expectedPaths.filter(validCheckoutRelativePath));
    if (packetPaths.size !== record.expectedPaths.length
      || remediation.correctionScope.some((path) => !packetPaths.has(path))) {
      return invalid("Remediation correction scope must be nonempty checkout-relative packet paths; blocked.");
    }
  }
  if (record.phase === "remediation" && remediation !== undefined && review !== undefined) {
    const findingIds = new Set(review.findings
      .filter((finding) => finding.classification === "blocker" || finding.classification === "fix-now")
      .map((finding) => finding.id));
    if (!remediation.sourceFindingIds.every((id) => findingIds.has(id))
      || remediation.sourceFindingIds.length !== findingIds.size) {
      return invalid("Remediation must retain every blocking source finding from the Scale review; blocked.");
    }
  }
  if (inspection !== undefined) {
    const changed = new Set(inspection.materiallyChangedPaths);
    if (inspection.outOfScopeChanges.some((entry) => changed.has(entry.path))) {
      return invalid("Primary inspection marks a materially changed path as out of scope; blocked.");
    }
  }
  if (review !== undefined && scaleAdmission !== undefined
    && (review.admissionId !== scaleAdmission.admissionId || review.runId !== scaleAdmission.boundRunId)) {
    return invalid("Scale review is not bound to the current Scale admission and run; blocked.");
  }
  if (review !== undefined && scaleWaiver !== undefined) {
    return invalid("A workflow cannot retain both a Scale review and Scale waiver as current gate evidence; blocked.");
  }
  if (record.phase === "scale-waived" && review !== undefined) {
    return invalid("A Scale-waived workflow cannot also retain a Scale review; blocked.");
  }
  if (record.phase === "review-passed" && scaleWaiver !== undefined) {
    return invalid("A review-passed workflow cannot also retain a Scale waiver; blocked.");
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
  if (transition.to === "evidence-ready" || transition.to === "scale-running") {
    if (!current.primaryInspection || !validPrimaryInspection(current.primaryInspection, current.acceptanceChecks)) {
      throw new Error("Evidence-ready and Scale admission require a complete current Primary inspection covering every packet acceptance check.");
    }
    if (transition.to === "scale-running" && current.scaleWaiver !== undefined) {
      throw new Error("A Scale-waived workflow cannot also enter Scale review without a fresh gate decision.");
    }
  }
  if (transition.to === "review-passed") {
    if (current.scaleWaiver !== undefined) throw new Error("A Scale-waived workflow cannot also pass a Scale review.");
    if (!current.scaleAdmission?.boundRunId
      || current.scaleReview?.admissionId !== current.scaleAdmission.admissionId
      || current.scaleReview.runId !== current.scaleAdmission.boundRunId) {
      throw new Error("Review-passed requires an append-acknowledged exact Scale admission and run binding.");
    }
    if (!current.primaryInspection || !validPrimaryInspection(current.primaryInspection, current.acceptanceChecks)
      || !current.scaleReview || !validScaleReview(current.scaleReview, current.primaryInspection)) {
      throw new Error("Review-passed requires a complete current Primary inspection and Scale review.");
    }
    if (current.scaleReview.verdict !== "pass") throw new Error("Review-passed requires a passing Scale review.");
  }
  if (transition.to === "scale-waived") {
    if (current.scaleReview !== undefined) throw new Error("A workflow with a Scale review cannot also enter Scale-waived state.");
    if (!current.primaryInspection || !validPrimaryInspection(current.primaryInspection, current.acceptanceChecks)
      || !current.scaleWaiver || !validScaleWaiver(current.scaleWaiver, current.workItemId)) {
      throw new Error("Scale waiver requires a complete current Primary inspection and valid bounded waiver.");
    }
  }
  if (transition.to === "accepted") {
    const reviewPath = current.phase === "review-passed"
      && current.primaryInspection !== undefined
      && current.scaleReview !== undefined
      && validPrimaryInspection(current.primaryInspection, current.acceptanceChecks)
      && validScaleReview(current.scaleReview, current.primaryInspection)
      && current.scaleReview.verdict === "pass"
      && current.scaleAdmission?.boundRunId === current.scaleReview.runId
      && current.scaleAdmission.admissionId === current.scaleReview.admissionId;
    const waiverPath = current.phase === "scale-waived"
      && current.primaryInspection !== undefined
      && current.scaleWaiver !== undefined
      && validScaleWaiver(current.scaleWaiver, current.workItemId);
    if (!reviewPath && !waiverPath) throw new Error("Acceptance requires a current passing Scale review or a valid bounded Scale waiver.");
  }
  if (transition.to === "remediation") {
    if (current.phase !== "scale-running" || !current.primaryInspection || !current.scaleReview
      || !validScaleReview(current.scaleReview, current.primaryInspection)
      || current.scaleReview.verdict !== "changes-required"
      || !current.scaleReview.findings.some((finding) => finding.classification === "blocker" || finding.classification === "fix-now")) {
      throw new Error("Remediation requires a current Scale review with a blocker or fix-now finding.");
    }
  }
  const next = cloneRecord(current);
  if (transition.to === "review-passed" && next.remediation !== undefined) {
    next.remediation = { ...next.remediation, active: false };
  }
  if (transition.to === "remediation") {
    const review = next.scaleReview!;
    const blocking = review.findings.filter((finding) => finding.classification === "blocker" || finding.classification === "fix-now");
    const attempt = (current.remediation?.attempt ?? 0) + 1;
    if (attempt > MAX_REMEDIATION_ATTEMPTS) throw new Error(`Remediation is capped at ${MAX_REMEDIATION_ATTEMPTS} correction attempts.`);
    const correctionScope = transition.correctionScope === undefined
      ? [...current.expectedPaths]
      : [...transition.correctionScope];
    if (correctionScope.length === 0
      || new Set(correctionScope).size !== correctionScope.length
      || !correctionScope.every(validCheckoutRelativePath)
      || correctionScope.some((path) => !current.expectedPaths.includes(path))) {
      throw new Error("Remediation correction scope must be a nonempty subset of packet expected paths.");
    }
    // A fresh remediation cycle always gets a fresh bounded record. Direct
    // transition callers use packet paths; the trusted controller supplies its
    // narrower correction scope explicitly.
    next.remediation = {
      id: `remediation-${review.id}-${attempt}`,
      sourceReviewId: review.id,
      sourceFindingIds: blocking.map((finding) => finding.id),
      correctionScope,
      attempt,
      maxAttempts: MAX_REMEDIATION_ATTEMPTS,
      active: true,
      createdAt: transition.timestamp,
    };
  }
  if (transition.to === "hand-running" && (current.phase === "remediation" || current.remediation?.active === true)) {
    // A correction assignment can never inherit acceptance evidence. Keep the
    // bounded remediation linkage, but force a full reinspection/re-review.
    next.primaryInspection = undefined;
    next.scaleReview = undefined;
    next.scaleAdmission = undefined;
    next.scaleWaiver = undefined;
    next.scaleVerdict = undefined;
    next.scaleWaiverReference = undefined;
  }
  // Retain a bound passing admission through review-passed/accepted so the
  // canonical record durably proves the exact reviewed run. Other exits clear
  // the one-run reservation; remediation retains linkage through its review.
  if (transition.to !== "scale-running" && transition.to !== "review-passed" && transition.to !== "remediation" && transition.to !== "accepted") {
    next.scaleAdmission = undefined;
  }
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
