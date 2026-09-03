import {
  ROADMAP_STATUSES,
  WORKFLOW_ACTORS,
  WORKFLOW_CLASSIFICATIONS,
  WORKFLOW_PHASES,
  type RoadmapStatus,
  type WorkflowActor,
  type WorkflowClassification,
  type WorkflowPhase,
  type WorkflowRecord,
  type WorkflowRoadmapItem,
} from "./types.ts";

const CLASSIFICATIONS = new Set<string>(WORKFLOW_CLASSIFICATIONS);
const PHASES = new Set<string>(WORKFLOW_PHASES);
const STATUSES = new Set<string>(ROADMAP_STATUSES);
const ACTORS = new Set<string>(WORKFLOW_ACTORS);
const PRIMARY_ONLY_PHASES = new Set<WorkflowPhase>(["tdd-waived", "scale-waived", "accepted", "rejected"]);
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
  ] as const;
  for (const key of optionalKeys) {
    const value = record[key];
    if (value !== undefined) {
      (cloned as unknown as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value;
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
  if (!record.requirementIds.every(nonEmptyString)
    || !record.nonGoals.every((entry) => typeof entry === "string")
    || !record.expectedPaths.every((entry) => typeof entry === "string")
    || !record.blockers.every((entry) => typeof entry === "string")
    || !record.residualRisks.every((entry) => typeof entry === "string")) {
    return invalid("Workflow record contains malformed collection state; blocked.");
  }
  if ((record.unresolvedDecisions !== undefined && !isStringArray(record.unresolvedDecisions))
    || (record.redTestReference !== undefined && typeof record.redTestReference !== "string")
    || (record.tddWaiverReference !== undefined && typeof record.tddWaiverReference !== "string")
    || (record.scaleVerdict !== undefined && typeof record.scaleVerdict !== "string")
    || (record.scaleWaiverReference !== undefined && typeof record.scaleWaiverReference !== "string")
    || (record.changedScopeSummary !== undefined && typeof record.changedScopeSummary !== "string")
    || (record.latestCapsuleReference !== undefined && typeof record.latestCapsuleReference !== "string")) {
    return invalid("Workflow record contains malformed optional state; blocked.");
  }
  const items = record.roadmap;
  const roadmapIds = new Set<string>();
  for (const item of items) {
    if (!isRoadmapItem(item)) return invalid("Workflow record contains a malformed roadmap item; blocked.");
    if (roadmapIds.has(item.id)) return invalid("Workflow record contains duplicate roadmap state; blocked.");
    roadmapIds.add(item.id);
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
  if ((transition.to === "accepted" || transition.to === "rejected" || transition.to === "tdd-waived" || transition.to === "scale-waived")
    && transition.actor !== "Primary") {
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
