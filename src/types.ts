export const FACULTIES = ["eye", "hand", "scale"] as const;
export type Faculty = (typeof FACULTIES)[number];
export type AgentName = `godmode-${Faculty}`;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type GodmodeThinking = "medium" | "high" | "xhigh";

export interface ModelTuple {
  provider: string;
  model: string;
}

export interface FacultyConfig extends ModelTuple {
  thinking: ThinkingLevel;
  /** Soft elapsed deadline; Godmode derives a finite hard backstop. */
  timeoutMs: number;
}

export interface GodmodeConfig {
  schemaVersion: 1;
  godmodePolicy: {
    allowedModels: ModelTuple[];
    minimumThinking: GodmodeThinking;
  };
  faculties: Record<Faculty, FacultyConfig>;
}

export interface DelegationInput {
  faculty: Faculty;
  title: string;
  task: string;
  contextFiles?: string[];
  expectedPaths?: string[];
  acceptanceChecks?: string[];
  constraints?: string[];
}

export interface NormalizedDelegation extends DelegationInput {
  contextFiles: string[];
  expectedPaths: string[];
  acceptanceChecks: string[];
  constraints: string[];
}

export type ModePhase = "off" | "enabling" | "active" | "degraded" | "stopping";
export type DelegationPhase = "idle" | "launching" | "running" | "attention" | "stopping" | "terminal";
export type TerminalRunState = "complete" | "failed" | "stopped" | "rejected" | "timed_out";
export type DeadlinePhase = "normal" | "pending" | "extended" | "hard";
export type CheckpointState = "not_requested" | "pending" | "requested" | "failed";

export interface DeadlineStatus {
  phase: DeadlinePhase;
  softDeadlineAt: number;
  hardDeadlineAt: number;
  remainingMs: number;
  hardRemainingMs: number;
  checkpoint: CheckpointState;
  checkpointRequestedAt?: number;
  extensionMs?: number;
}

export interface ActiveRun {
  runId?: string;
  faculty: Faculty;
  agent: AgentName;
  title: string;
  assignment: string;
  phase: Exclude<DelegationPhase, "idle" | "terminal">;
  startedAt: number;
  /** Present for runs launched by the current deadline-aware mode. */
  deadline?: DeadlineStatus;
  result?: unknown;
}

export interface GodmodeSnapshot {
  phase: ModePhase;
  delegation: DelegationPhase;
  activeRun?: Readonly<ActiveRun>;
  lastRun?: {
    runId: string;
    faculty: Faculty;
    state: TerminalRunState;
    deadline?: Readonly<DeadlineStatus>;
    result?: unknown;
  };
  degradedReason?: string;
}

export interface Disposable {
  dispose(): void;
}

export interface AsyncRunStatus {
  runId: string;
  state: "queued" | "running" | "needs_attention" | "stopping" | TerminalRunState;
  raw?: unknown;
}

export interface SpawnReceipt {
  runId: string;
  state: "queued" | "running";
  raw?: unknown;
}

/** Canonical workflow classifications. These are deliberately separate from
 * the operational mode and delegation phases above. */
export const WORKFLOW_CLASSIFICATIONS = [
  "feature",
  "bugfix",
  "refactor/maintenance",
  "documentation/configuration",
  "test-only/tooling",
] as const;
export type WorkflowClassification = (typeof WORKFLOW_CLASSIFICATIONS)[number];

export const WORKFLOW_PHASES = [
  "draft",
  "classified",
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
  "blocked",
  "rejected",
] as const;
export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

export const ROADMAP_STATUSES = [
  "pending",
  "implemented-unverified",
  "verified",
  "blocked",
  "waived",
] as const;
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

export const WORKFLOW_ACTORS = ["Primary", "Eye", "Hand", "Scale"] as const;
export type WorkflowActor = (typeof WORKFLOW_ACTORS)[number];

/** A bounded pointer to evidence; raw evidence is intentionally not part of
 * the canonical record. */
export interface BoundedEvidenceReference {
  id: string;
  kind?: string;
  label?: string;
  source?: string;
  createdAt?: string;
  expiresAt?: string;
}
export type EvidenceReference = BoundedEvidenceReference;

export interface PhaseTransitionAudit {
  kind: "phase";
  workItemId: string;
  from: WorkflowPhase;
  to: WorkflowPhase;
  actor: WorkflowActor;
  timestamp: string;
  reason: string;
  reference: string;
}

export interface RoadmapTransitionAudit {
  kind: "roadmap";
  workItemId: string;
  roadmapItemId: string;
  from: RoadmapStatus;
  to: RoadmapStatus;
  actor: WorkflowActor;
  timestamp: string;
  reason: string;
  reference: string;
}
export type WorkflowTransitionAudit = PhaseTransitionAudit | RoadmapTransitionAudit;
export type TransitionAuditRecord = WorkflowTransitionAudit;

export interface WorkflowRoadmapItem {
  id: string;
  requirementIds: string[];
  title: string;
  status: RoadmapStatus;
  /** Optional status explanation, retained as bounded prose. */
  reason?: string;
}
export type RoadmapItem = WorkflowRoadmapItem;

export interface WorkflowRecord {
  workItemId: string;
  classification: WorkflowClassification;
  goal: string;
  requirementIds: string[];
  nonGoals: string[];
  expectedPaths: string[];
  phase: WorkflowPhase;
  roadmap: WorkflowRoadmapItem[];
  history: WorkflowTransitionAudit[];
  nextGate: string;
  blockers: string[];
  residualRisks: string[];
  evidence: BoundedEvidenceReference[];
  /** Bounded current-state details used by recovery/projection when present. */
  unresolvedDecisions?: string[];
  redTestReference?: string;
  tddWaiverReference?: string;
  scaleVerdict?: string;
  scaleWaiverReference?: string;
  changedScopeSummary?: string;
  latestCapsuleReference?: string;
}

export interface LedgerSnapshot {
  schemaVersion: 1;
  sessionId: string;
  workItemId: string;
  generation: number;
  predecessorEntryId: string | null;
  createdAt: string;
  record: WorkflowRecord;
}
export type WorkflowLedgerSnapshot = LedgerSnapshot;

export interface LedgerSnapshotInput {
  sessionId: string;
  workItemId: string;
  generation: number;
  predecessorEntryId?: string | null;
  createdAt: string;
  record: WorkflowRecord;
}

export interface WorkflowProjection {
  text: string;
  truncated: boolean;
  blocked: boolean;
  reason?: string;
}
export type ActiveWorkflowProjection = WorkflowProjection;

export interface CompletionCapsule {
  schemaVersion: 1;
  workItemId: string;
  classification: WorkflowClassification;
  phase: WorkflowPhase;
  accepted: boolean;
  roadmap: Array<Pick<WorkflowRoadmapItem, "id" | "status">>;
  requirementIds: string[];
  nextGate: string;
  evidence: BoundedEvidenceReference[];
  blockers: string[];
  residualRisks: string[];
  createdAt: string;
  truncated: boolean;
  redTestReference?: string;
  tddWaiverReference?: string;
  scaleVerdict?: string;
  scaleWaiverReference?: string;
  changedScopeSummary?: string;
}
