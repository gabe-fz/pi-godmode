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
  /** Trusted Scale admission identity, present only for a Scale run. */
  admissionId?: string;
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
    /** Trusted Scale admission identity, retained for exact review correlation. */
    admissionId?: string;
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

/** The only supported interface surfaces for Phase 4 evidence. */
export const INTERFACE_SURFACES = [
  "browser-ui",
  "tui",
  "api",
  "cli",
  "library",
  "persistence-migration",
  "build-config",
  "documentation",
] as const;
export type InterfaceSurface = (typeof INTERFACE_SURFACES)[number];

/** The canonical, non-substitutable verification method for each surface. */
export const INTERFACE_METHOD_BY_SURFACE = {
  "browser-ui": "real-browser-flow",
  tui: "deterministic-pty",
  api: "controlled-request",
  cli: "executable-invocation",
  library: "downstream-consumer",
  "persistence-migration": "disposable-storage",
  "build-config": "supported-build-config-check",
  documentation: "rendered-doc-validation",
} as const satisfies Record<InterfaceSurface, string>;
export type InterfaceEvidenceMethod = (typeof INTERFACE_METHOD_BY_SURFACE)[InterfaceSurface];

/** Static, read-only Phase 5 doctor classifications. */
export type DoctorStatus = "ready" | "partial" | "blocked";
export type DoctorBasis = "observed" | "inferred" | "proposed";
export type DoctorConfidence = "high" | "medium" | "low";

export interface DoctorLimits {
  maxDepth: number;
  maxScannedEntries: number;
  maxFileBytes: number;
  maxAggregateReadBytes: number;
  maxSafetyFindings: number;
  maxCommands: number;
  maxTests: number;
  maxDocsConfig: number;
  maxSurfaces: number;
  maxGaps: number;
  maxProposals: number;
  maxFieldBytes: number;
  maxReportBytes: number;
  scannedEntries: number;
  aggregateReadBytes: number;
  truncated: boolean;
  truncationReasons: string[];
}

export interface DoctorProjectType {
  type: string;
  evidencePaths: string[];
  basis: DoctorBasis;
  confidence: DoctorConfidence;
}

export interface DoctorSurface {
  surface: InterfaceSurface;
  evidencePaths: string[];
  basis: DoctorBasis;
  confidence: DoctorConfidence;
}

export interface DoctorTestCandidate {
  path: string;
  kind: string;
  evidencePaths: string[];
  basis: DoctorBasis;
  confidence: DoctorConfidence;
}

export interface DoctorCommandCandidate {
  command: string;
  sourcePath: string;
  kind: string;
  requiresExplicitApproval: true;
  basis: DoctorBasis;
  confidence: DoctorConfidence;
}

export interface DoctorDocConfigItem {
  path: string;
  category: string;
  evidencePaths: string[];
  basis: DoctorBasis;
  confidence: DoctorConfidence;
}

export interface DoctorVerificationNeed {
  surface: InterfaceSurface;
  method: InterfaceEvidenceMethod;
  reason: string;
  basis: DoctorBasis;
  confidence: DoctorConfidence;
}

export interface DoctorFinding {
  category: string;
  path?: string;
  detail?: string;
  basis: DoctorBasis;
  confidence: DoctorConfidence;
}

export interface DoctorProposal {
  path: string;
  kind: "validation-profile" | "workflow-guidance";
  rationale: string;
  basis: "proposed";
  confidence: DoctorConfidence;
}

export interface DoctorRootIdentity {
  path: string;
  identity: string;
  basis: "observed";
  confidence: DoctorConfidence;
}

/** Counts retain category cardinality when a report is compacted for its
 * complete-object serialization bound. */
export interface DoctorReportSummary {
  projectTypes: number;
  surfaces: number;
  testCandidates: number;
  /** Compatibility alias used by the compact rendered summary. */
  tests?: number;
  commands: number;
  docsConfig: number;
  verificationNeeds: number;
  gaps: number;
  safetyFindings: number;
  proposals: number;
}

export interface DoctorReport {
  schema: "godmode-doctor";
  schemaVersion: 1;
  version: 1;
  root: DoctorRootIdentity;
  /** Compatibility spelling for callers that use the requirement's wording. */
  rootIdentity: DoctorRootIdentity;
  status: DoctorStatus;
  readOnly: true;
  applyAvailable: false;
  limits: DoctorLimits;
  /** Returned reports include this; optional keeps renderer input backward-compatible. */
  summary?: DoctorReportSummary;
  projectTypes: DoctorProjectType[];
  surfaces: DoctorSurface[];
  testCandidates: DoctorTestCandidate[];
  commands: DoctorCommandCandidate[];
  /** Compatibility spelling retained as a descriptive alias. */
  inertCommandCandidates: DoctorCommandCandidate[];
  docsConfig: DoctorDocConfigItem[];
  verificationNeeds: DoctorVerificationNeed[];
  gaps: DoctorFinding[];
  safetyFindings: DoctorFinding[];
  proposals: DoctorProposal[];
  /** Bounded deterministic presentation; it is never interpreted as input. */
  rendered: string;
}

/** Phase 6 apply types are re-exported here for callers that keep all
 * authority-bearing data shapes in the canonical types module. */
export type {
  DoctorApplyConflict,
  DoctorApplyMode,
  DoctorApplyOperation,
  DoctorApplyOptions,
  DoctorApplyPreview,
  DoctorApplyRecoveryResult,
  DoctorApplyResult,
  DoctorApplyTargetSnapshot,
  DoctorLegacyHint,
} from "./doctor-apply.ts";

/** Compatibility aliases used by evidence-focused callers. */
export const SURFACES = INTERFACE_SURFACES;
export const SURFACE_METHODS = INTERFACE_METHOD_BY_SURFACE;
export type EvidenceSurface = InterfaceSurface;
export type EvidenceApplicability = "applicable" | "not-applicable";
export type InterfaceEvidenceResult = "passed" | "failed" | "blocked";

/** Primary-authored description of one interface-matched check. */
export interface AcceptanceCheckSpec {
  id: string;
  surface: InterfaceSurface;
  /** Runtime validation enforces the canonical value for the surface. */
  method: string;
  requirementIds: string[];
  /** Primary-observed interaction/invocation description; never executable input. */
  interaction: string;
  scenario?: string;
  expectedOutcome?: string;
}

/** One decision for a requirement/surface pair. */
export interface EvidenceApplicabilityDecision {
  surface: InterfaceSurface;
  requirementIds: string[];
  applicability: EvidenceApplicability;
  /** Required for both branches and intentionally bounded. */
  reason: string;
  actor: "Primary";
  decidedAt: string;
  inspectionId: string;
  diffFingerprint: string;
}

/** Bounded evidence observed by Primary for one declared interface check. */
export interface InterfaceEvidenceRecord {
  id: string;
  workItemId: string;
  requirementIds: string[];
  surface: InterfaceSurface;
  /** Runtime validation enforces the canonical value for the surface/check. */
  method: string;
  acceptanceCheckId: string;
  scenario: string;
  invocation: string;
  environment: string;
  observedResult: string;
  artifactReferences: Array<string | BoundedEvidenceReference>;
  result: InterfaceEvidenceResult;
  actor: "Primary";
  capturedAt: string;
  adapter: "primary-observed-artifact" | string;
  adapterVersion: "1";
  redactionStatus: "verified-clean";
  retentionClass: "session" | "review" | "durable";
  expiresAt: string;
  inspectionId: string;
  diffFingerprint: string;
}

/** A bounded pointer to evidence; raw evidence is intentionally not part of
 * the canonical record. */
export interface BoundedEvidenceReference {
  id: string;
  kind?: string;
  label?: string;
  /** Trusted source path for a bounded, externally retained artifact. */
  source?: string;
  /** Trusted content identity for inspection artifacts. */
  sha256?: string;
  /** Trusted byte bound for inspection artifacts. */
  bytes?: number;
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

/** A numbered, observable requirement in a Primary-authored packet. */
export interface FunctionalRequirement {
  id: string;
  description: string;
  interface: string;
}

export interface WorkflowRoadmapItem {
  id: string;
  requirementIds: string[];
  title: string;
  status: RoadmapStatus;
  /** Optional status explanation, retained as bounded prose. */
  reason?: string;
}
export type RoadmapItem = WorkflowRoadmapItem;

/**
 * Primary-authored packet metadata is kept on the canonical ledger record.
 * These fields deliberately do not appear on DelegationInput: a model-facing
 * caller cannot manufacture workflow authority or red-test provenance.
 */
export interface RedTestEvidence {
  id: string;
  command: string;
  /** Bounded description of the controlled environment used for the observation. */
  environment: string;
  exitStatus: number;
  requirementIds: string[];
  /** Checkout-relative path to the immutable red test. */
  testPath: string;
  /** SHA-256 of the complete test content observed by Primary. */
  testContentHash: string;
  observedBy: "Primary";
  observedAt: string;
  failureKind: "missing-behavior";
  outputExcerpt?: string;
  artifactReference?: string | BoundedEvidenceReference;
}

export interface TddWaiver {
  id: string;
  /** The named work item or gate covered by this waiver. */
  item: string;
  requirementIds: string[];
  inapplicableSeam: string;
  reason: string;
  /** `actor` is the canonical spelling; approver is retained for packet compatibility. */
  actor?: "Primary";
  approver?: "Primary";
  /** ISO date or canonical UTC timestamp supplied by the Primary. */
  date: string;
  /** A bounded description or list of the exact waived scope. */
  scope: string | string[];
  compensatingCheck?: string;
  compensatingEvidence?: string | BoundedEvidenceReference;
}
export type TDDWaiver = TddWaiver;
export type RedEvidence = RedTestEvidence;

/** A bounded, authority-bearing record of the Primary's complete checkout
 * inspection. Raw diffs, command output, and transcripts remain outside the
 * canonical ledger; these fields retain only references and fingerprints. */
export interface IndependentCheck {
  id: string;
  command: string;
  result: "passed" | "failed";
  evidenceReference: string | BoundedEvidenceReference;
}

export interface PrimaryInspection {
  id: string;
  actor: "Primary";
  inspectedAt: string;
  statusReference: string | BoundedEvidenceReference;
  completeDiffReference: string | BoundedEvidenceReference;
  diffFingerprint: string;
  materiallyChangedPaths: string[];
  outOfScopeChanges: Array<{ path: string; disposition: string }>;
  independentChecks: IndependentCheck[];
  residualRisks: string[];
}

export type ScaleFindingClassification = "blocker" | "fix-now" | "optional";

/**
 * Current Scale admission. The nonce and admission ID are generated by the
 * trusted Primary runtime, never accepted from model-facing workflow input.
 * `boundRunId` is appended only after the spawn receipt is acknowledged.
 */
export interface ScaleAdmission {
  admissionId: string;
  nonce: string;
  workItemId: string;
  inspectionId: string;
  diffFingerprint: string;
  admittedAt: string;
  boundRunId?: string;
}

export interface ScaleFinding {
  id: string;
  classification: ScaleFindingClassification;
  evidenceReference: string | BoundedEvidenceReference;
  summary: string;
}

export interface ScaleReview {
  id: string;
  /** Bound internally to the exact latest completed Scale run. */
  runId: string;
  /** Bound internally to the exact Scale admission that produced the run. */
  admissionId: string;
  reviewer: "Scale";
  completedAt: string;
  freshContext: true;
  diffFingerprint: string;
  evidenceReferences: Array<string | BoundedEvidenceReference>;
  verdict: "pass" | "changes-required";
  findings: ScaleFinding[];
  residualUncertainty: string;
}

export type ScaleWaiverBasis = "user-explicit" | "policy";

export interface ScaleWaiver {
  id: string;
  item: string;
  basis: ScaleWaiverBasis;
  actor: "Primary";
  approver: "Primary";
  date: string;
  scope: string | string[];
  reason: string;
  riskLimit: string;
  compensatingEvidence: string | BoundedEvidenceReference;
  /** Active-branch user message consumed for a user-explicit waiver. */
  userMessageEntryId?: string;
  /** Trusted hash/stamp of the strict policy file for policy waivers. */
  policyReference?: string | BoundedEvidenceReference;
  owner?: string;
  /** Policy expiry and review are canonical UTC timestamps. */
  expiresAt?: string;
  reviewAt?: string;
}

export interface Remediation {
  id: string;
  sourceReviewId: string;
  sourceFindingIds: string[];
  /** Checkout-relative mutation paths explicitly bounded by the packet. */
  correctionScope: string[];
  attempt: number;
  maxAttempts: number;
  active: boolean;
  createdAt: string;
}

/** Small explicit loop cap; each new correction requires a fresh inspection
 * and Scale run rather than reusing stale acceptance evidence. */
export const MAX_REMEDIATION_ATTEMPTS = 3 as const;

export interface WorkflowRecord {
  workItemId: string;
  classification: WorkflowClassification;
  goal: string;
  requirementIds: string[];
  /** Required for specified and later packets; optional for legacy drafts. */
  functionalRequirements?: FunctionalRequirement[];
  nonGoals: string[];
  expectedPaths: string[];
  phase: WorkflowPhase;
  roadmap: WorkflowRoadmapItem[];
  history: WorkflowTransitionAudit[];
  nextGate: string;
  blockers: string[];
  residualRisks: string[];
  evidence: BoundedEvidenceReference[];
  /** Optional while a legacy draft is being assembled; required by specified. */
  packetAuthor?: "Primary";
  acceptanceChecks?: string[];
  authorityConstraints?: string[];
  redTestEvidence?: RedTestEvidence;
  tddWaiver?: TddWaiver;
  /** Bounded current-state details used by recovery/projection when present. */
  unresolvedDecisions?: string[];
  redTestReference?: string;
  tddWaiverReference?: string;
  scaleVerdict?: string;
  scaleWaiverReference?: string;
  changedScopeSummary?: string;
  latestCapsuleReference?: string;
  /** Current bounded Phase 3 gate records. Raw diffs/transcripts are never retained. */
  primaryInspection?: PrimaryInspection;
  /** Additive Phase 4 policy and current interface-matched evidence matrix. */
  interfaceEvidencePolicy?: "interface-matched-v1";
  acceptanceCheckSpecs?: AcceptanceCheckSpec[];
  applicabilityDecisions?: EvidenceApplicabilityDecision[];
  interfaceEvidence?: InterfaceEvidenceRecord[];
  /** Current Scale admission; absent after review/waiver or failed lifecycle. */
  scaleAdmission?: ScaleAdmission;
  scaleReview?: ScaleReview;
  scaleWaiver?: ScaleWaiver;
  remediation?: Remediation;
}

/**
 * Persisted authority binding for a generation-one snapshot created while
 * entering a forked session. The parent session path is deliberately not
 * retained; its bounded SHA-256 fingerprint is enough for recovery to bind
 * the successor to the trusted SessionManager header.
 */
export interface LedgerForkOrigin {
  parentSessionFingerprint: string;
  sourceSessionId: string;
  sourceEntryId: string;
  sourceGeneration: number;
  sourceRecord: WorkflowRecord;
}

export interface LedgerSnapshot {
  /** Schema v1 remains compatible with ordinary (non-fork) snapshots. */
  schemaVersion: 1;
  sessionId: string;
  workItemId: string;
  generation: number;
  predecessorEntryId: string | null;
  createdAt: string;
  record: WorkflowRecord;
  forkOrigin?: LedgerForkOrigin;
}
export type WorkflowLedgerSnapshot = LedgerSnapshot;

export interface LedgerSnapshotInput {
  sessionId: string;
  workItemId: string;
  generation: number;
  predecessorEntryId?: string | null;
  createdAt: string;
  record: WorkflowRecord;
  /** Set only by the proof-authorized fork append path. */
  forkOrigin?: LedgerForkOrigin;
}

/** Header-derived context required to recover a persisted fork successor. */
export interface LedgerRecoveryContext {
  readonly sessionId?: string;
  readonly parentSessionFile?: string;
}
export type TrustedRecoveryContext = LedgerRecoveryContext;

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
  interfaceEvidencePolicy?: "interface-matched-v1";
  interfaceEvidenceSummary?: {
    checkCount: number;
    decisionCount: number;
    evidenceCount: number;
    passed: number;
    failed: number;
    blocked: number;
  };
}
