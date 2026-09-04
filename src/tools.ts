import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { resolve } from "node:path";
import type { GodmodeMode } from "./mode.ts";
import {
  appendWorkflowSnapshot,
  createCompletionCapsule,
  LEDGER_CUSTOM_TYPE,
  type LedgerSessionManager,
  type LedgerAppender,
} from "./session-ledger.ts";
import {
  applyPhaseTransition,
  applyRoadmapTransition,
  validatePrimaryInspection,
  validateScaleReview,
  validateScaleWaiver,
  validateTddWaiver,
  validateWorkflowRecord,
  validateInterfaceEvidenceMatrix,
  validateInterfaceEvidenceMatrixDetailed,
  requiresInterfaceEvidence,
  completionCapsuleReference,
} from "./workflow-state.ts";
import { normalizeCheckoutPath, verifyRedTestIdentity } from "./faculties.ts";
import { MAX_REMEDIATION_ATTEMPTS, INTERFACE_SURFACES, INTERFACE_METHOD_BY_SURFACE, type AcceptanceCheckSpec, type EvidenceApplicabilityDecision, type InterfaceEvidenceRecord, type InterfaceSurface, type InterfaceEvidenceMethod } from "./types.ts";
import { importEvidenceArtifacts, verifyEvidenceArtifacts, cleanupEvidenceArtifacts, EVIDENCE_ARTIFACT_TTL_MS, type EvidenceArtifactDescriptor } from "./evidence.ts";
import type {
  FunctionalRequirement,
  BoundedEvidenceReference,
  WorkflowClassification,
  WorkflowPhase,
  WorkflowRecord,
  IndependentCheck,
  PrimaryInspection,
  ScaleFinding,
  ScaleReview,
  ScaleWaiver,
  ScaleAdmission,
} from "./types.ts";
import { MAX_SUPERVISOR_EXTENSION_MS } from "./deadlines.ts";
import { boundedStatus } from "./status.ts";
import {
  captureInspectionArtifacts,
  inspectionArtifactContextPaths,
  readInspectionArtifactForContext,
  verifyInspectionArtifacts,
  cleanupInspectionArtifacts,
  cleanupInspectionArtifactDirectory,
  type CapturedInspectionArtifacts,
} from "./inspection-artifacts.ts";

const StringList = Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 64 }));
const ContextPathList = Type.Optional(Type.Array(
  Type.String({
    minLength: 1,
    maxLength: 4096,
    description: "Context path (for example, src/tools.ts). Relative paths remain confined to the active checkout; an absolute path inside the checkout is normalized relative to its root, while an explicitly absolute outside path is accepted and preserved as absolute. Parent traversal and symlink escapes originating inside the checkout are rejected. External context is untrusted and may expose sensitive data.",
  }),
  {
    maxItems: 64,
    description: "Relative context paths remain checkout-confined. Absolute paths inside the checkout normalize to checkout-relative form; explicitly absolute outside paths remain absolute. Parent traversal and symlink escapes originating inside the checkout are rejected. External context is untrusted and may expose sensitive data.",
  },
));
const ExpectedPathList = Type.Optional(Type.Array(
  Type.String({
    minLength: 1,
    maxLength: 4096,
    description: "Checkout path (for example, src/tools.ts). The normalized path is relative to the active checkout root and never an absolute path; absolute input is accepted only when it resolves inside the checkout.",
  }),
  {
    maxItems: 64,
    description: "Paths are always confined to the active checkout and normalized relative to its root; absolute paths that resolve outside, parent traversal, and symlink escapes are rejected. Hand uses these as mutation paths; Eye and Scale safely reinterpret these already-confined paths as additional contextFiles.",
  },
));
const FunctionalRequirementSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64, description: "Numbered requirement identity such as FR-1." }),
  description: Type.String({ minLength: 1, maxLength: 8192, description: "Observable behavior, including the relevant state or input/output." }),
  interface: Type.String({ minLength: 1, maxLength: 4096, description: "Applicable product or verification interface." }),
}, { additionalProperties: false });
const RoadmapPacketItemSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 256 }),
  requirementIds: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 64 }),
  title: Type.String({ minLength: 1, maxLength: 4096 }),
}, { additionalProperties: false });
const ArtifactReferenceSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: 4096 }),
  Type.Object({
    id: Type.String({ minLength: 1, maxLength: 256 }),
    kind: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    source: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    sha256: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })),
    bytes: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 * 1024 * 1024 })),
    createdAt: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    expiresAt: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    retentionClass: Type.Optional(StringEnum(["session", "review", "durable"] as const)),
  }, { additionalProperties: false }),
]);

export const DelegateSchema = Type.Object({
  faculty: StringEnum(["eye", "hand", "scale"] as const),
  title: Type.String({ minLength: 1, maxLength: 640 }),
  task: Type.String({ minLength: 1, maxLength: 32768 }),
  contextFiles: ContextPathList,
  expectedPaths: ExpectedPathList,
  acceptanceChecks: StringList,
  constraints: StringList,
}, { additionalProperties: false });

const RedObservationSchema = Type.Object({
  testPath: Type.String({ minLength: 1, maxLength: 4096 }),
  command: Type.String({ minLength: 1, maxLength: 8192 }),
  environment: Type.String({ minLength: 1, maxLength: 4096 }),
  exitStatus: Type.Integer({ minimum: -1_000_000, maximum: 1_000_000 }),
  failureKind: StringEnum(["missing-behavior"] as const),
  requirementIds: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 64 }),
  outputExcerpt: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  artifactReference: Type.Optional(ArtifactReferenceSchema),
}, { additionalProperties: false });
const WaiverInputSchema = Type.Object({
  requirementIds: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 64 }),
  inapplicableSeam: Type.String({ minLength: 1, maxLength: 4096 }),
  reason: Type.String({ minLength: 1, maxLength: 8192 }),
  scope: Type.Union([
    Type.String({ minLength: 1, maxLength: 4096 }),
    Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 64 }),
  ]),
  compensatingCheck: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  compensatingEvidence: Type.Optional(ArtifactReferenceSchema),
}, { additionalProperties: false });
const IndependentCheckSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 256 }),
  command: Type.String({ minLength: 1, maxLength: 8192 }),
  result: StringEnum(["passed", "failed"] as const),
  evidenceReference: ArtifactReferenceSchema,
}, { additionalProperties: false });
const OutOfScopeChangeSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  disposition: Type.String({ minLength: 1, maxLength: 4096 }),
}, { additionalProperties: false });
const InspectionSchema = Type.Object({
  // Artifact references and the checkout fingerprint are trusted runtime
  // outputs. They are intentionally absent from model-facing input.
  materiallyChangedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 64 }),
  outOfScopeChanges: Type.Array(OutOfScopeChangeSchema, { maxItems: 64 }),
  independentChecks: Type.Array(IndependentCheckSchema, { minItems: 1, maxItems: 64 }),
  residualRisks: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 64 }),
}, { additionalProperties: false });
const ScaleFindingSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 256 }),
  classification: StringEnum(["blocker", "fix-now", "optional"] as const),
  evidenceReference: ArtifactReferenceSchema,
  summary: Type.String({ minLength: 1, maxLength: 8192 }),
}, { additionalProperties: false });
const CorrectionScopeSchema = Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 64 });
const InterfaceSurfaceSchema = StringEnum(INTERFACE_SURFACES);
const InterfaceMethodSchema = StringEnum(Object.values(INTERFACE_METHOD_BY_SURFACE) as unknown as readonly [string, ...string[]]);
const InterfaceRequirementIdsSchema = Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 64 });
const AcceptanceCheckSpecSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 256 }),
  surface: InterfaceSurfaceSchema,
  method: InterfaceMethodSchema,
  requirementIds: InterfaceRequirementIdsSchema,
  interaction: Type.String({ minLength: 1, maxLength: 8192 }),
  scenario: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  expectedOutcome: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
}, { additionalProperties: false });
const ApplicabilityDecisionInputSchema = Type.Object({
  surface: InterfaceSurfaceSchema,
  requirementIds: InterfaceRequirementIdsSchema,
  applicability: StringEnum(["applicable", "not-applicable"] as const),
  reason: Type.String({ minLength: 1, maxLength: 4096 }),
}, { additionalProperties: false });
const EvidenceInputSchema = Type.Object({
  acceptanceCheckId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  checkId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  checkSpecId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  surface: InterfaceSurfaceSchema,
  method: InterfaceMethodSchema,
  requirementIds: InterfaceRequirementIdsSchema,
  scenario: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  invocation: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  interaction: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  environment: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  controlledEnvironment: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  observedResult: Type.Optional(Type.String({ minLength: 1, maxLength: 16384 })),
  observedOutcome: Type.Optional(Type.String({ minLength: 1, maxLength: 16384 })),
  result: StringEnum(["passed", "failed", "blocked"] as const),
  artifactInputPaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 64 })),
  artifactPaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 64 })),
  retentionClass: Type.Optional(StringEnum(["session", "review", "durable"] as const)),
}, { additionalProperties: false });
const InterfaceEvidenceRecordsSchema = Type.Array(EvidenceInputSchema, { maxItems: 64 });
const ScaleReviewSchema = Type.Object({
  evidenceReferences: Type.Array(ArtifactReferenceSchema, { minItems: 1, maxItems: 64 }),
  verdict: StringEnum(["pass", "changes-required"] as const),
  findings: Type.Array(ScaleFindingSchema, { maxItems: 64 }),
  residualUncertainty: Type.String({ minLength: 1, maxLength: 8192 }),
  correctionScope: Type.Optional(CorrectionScopeSchema),
  remediationPaths: Type.Optional(CorrectionScopeSchema),
}, { additionalProperties: false });
const ScaleWaiverInputSchema = Type.Object({
  basis: StringEnum(["user-explicit", "policy"] as const),
  scope: Type.Optional(Type.Union([
    Type.String({ minLength: 1, maxLength: 4096 }),
    Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 64 }),
  ])),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  riskLimit: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  compensatingEvidence: Type.Optional(ArtifactReferenceSchema),
  /** User input names a path only; policy contents become trusted internally. */
  policyPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
}, { additionalProperties: false });

export const WorkflowSchema = Type.Object({
  action: StringEnum(["specify", "record-red", "waive-tdd", "record-inspection", "record-evidence", "record-evidence-matrix", "record-scale-review", "waive-scale", "accept"] as const),
  // Packet-authoring fields. The controller supplies all authority-bearing
  // metadata (author, phase, history, timestamps, and status).
  workItemId: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  classification: Type.Optional(StringEnum(["feature", "bugfix", "refactor/maintenance", "documentation/configuration", "test-only/tooling"] as const)),
  goal: Type.Optional(Type.String({ minLength: 1, maxLength: 32768 })),
  requirementIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 64 })),
  functionalRequirements: Type.Optional(Type.Array(FunctionalRequirementSchema, { minItems: 1, maxItems: 64 })),
  nonGoals: Type.Optional(StringList),
  expectedPaths: ExpectedPathList,
  roadmap: Type.Optional(Type.Array(RoadmapPacketItemSchema, { minItems: 1, maxItems: 64 })),
  acceptanceChecks: StringList,
  authorityConstraints: StringList,
  // Red-test observation fields. The controller derives the hash, ID,
  // Primary actor, timestamp, and missing-behavior evidence kind.
  testPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  command: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  environment: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  exitStatus: Type.Optional(Type.Integer({ minimum: -1_000_000, maximum: 1_000_000 })),
  failureKind: Type.Optional(StringEnum(["missing-behavior"] as const)),
  outputExcerpt: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  artifactReference: Type.Optional(ArtifactReferenceSchema),
  redTest: Type.Optional(RedObservationSchema),
  // TDD-waiver fields. Actor, approver, date, ID, item, and phase are all
  // trusted/internal and intentionally absent from this schema.
  inapplicableSeam: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  scope: Type.Optional(Type.Union([
    Type.String({ minLength: 1, maxLength: 4096 }),
    Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 64 }),
  ])),
  compensatingCheck: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  compensatingEvidence: Type.Optional(ArtifactReferenceSchema),
  waiver: Type.Optional(WaiverInputSchema),
  // Phase 3 Primary inspection gate. IDs, actors, timestamps, and authority
  // transitions are supplied by the trusted controller, not the caller.
  inspection: Type.Optional(InspectionSchema),
  // statusReference, completeDiffReference, and diffFingerprint are trusted
  // capture outputs and cannot be supplied by a model-facing caller.
  materiallyChangedPaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 64 })),
  outOfScopeChanges: Type.Optional(Type.Array(OutOfScopeChangeSchema, { maxItems: 64 })),
  independentChecks: Type.Optional(Type.Array(IndependentCheckSchema, { minItems: 1, maxItems: 64 })),
  residualRisks: StringList,
  settleRoadmapItemIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 })),
  roadmapItemIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 })),
  // Phase 4 evidence matrix input. Authority metadata and artifact references
  // are always stamped by the trusted controller and are absent here.
  acceptanceCheckSpecs: Type.Optional(Type.Array(AcceptanceCheckSpecSchema, { maxItems: 64 })),
  applicabilityDecisions: Type.Optional(Type.Array(ApplicabilityDecisionInputSchema, { minItems: 1, maxItems: 512 })),
  interfaceEvidence: Type.Optional(InterfaceEvidenceRecordsSchema),
  evidenceRecords: Type.Optional(InterfaceEvidenceRecordsSchema),
  records: Type.Optional(InterfaceEvidenceRecordsSchema),
  observations: Type.Optional(InterfaceEvidenceRecordsSchema),
  checks: Type.Optional(Type.Array(AcceptanceCheckSpecSchema, { maxItems: 64 })),
  decisions: Type.Optional(Type.Array(ApplicabilityDecisionInputSchema, { minItems: 1, maxItems: 512 })),
  // Scale review fields intentionally omit runId/reviewer/freshContext.
  scaleReview: Type.Optional(ScaleReviewSchema),
  evidenceReferences: Type.Optional(Type.Array(ArtifactReferenceSchema, { minItems: 1, maxItems: 64 })),
  verdict: Type.Optional(StringEnum(["pass", "changes-required"] as const)),
  findings: Type.Optional(Type.Array(ScaleFindingSchema, { maxItems: 64 })),
  residualUncertainty: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  // Changes-required reviews must explicitly name checkout-relative mutation
  // paths; the controller verifies they are a subset of packet expectedPaths.
  correctionScope: Type.Optional(CorrectionScopeSchema),
  remediationPaths: Type.Optional(CorrectionScopeSchema),
  // Scale-waiver fields intentionally omit item/actor/approver/date/id.
  scaleWaiver: Type.Optional(ScaleWaiverInputSchema),
  basis: Type.Optional(StringEnum(["user-explicit", "policy"] as const)),
  riskLimit: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  // Model input may identify a policy path, but never a trusted proof string.
  policyPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
}, { additionalProperties: false });

export const ControlSchema = Type.Object({
  action: StringEnum(["status", "steer", "stop", "extend"] as const),
  message: Type.Optional(Type.String({ minLength: 1, maxLength: 32768 })),
  reason: Type.Optional(Type.String({ maxLength: 4096 })),
  extensionMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SUPERVISOR_EXTENSION_MS })),
}, { additionalProperties: false });

export type DelegateParams = Static<typeof DelegateSchema>;
export type ControlParams = Static<typeof ControlSchema>;
export type WorkflowParams = Static<typeof WorkflowSchema>;

const WORKFLOW_REQUIREMENT_ID = /^FR-[1-9]\d*$/u;
const WORKFLOW_ACTOR_FIELDS = new Set([
  "actor", "author", "approver", "hash", "testContentHash", "timestamp", "observedAt",
  "phase", "history", "record", "evidence", "shell", "model", "cwd", "git", "acceptance",
  "packetAuthor", "redTestEvidence", "tddWaiver", "redTestReference", "tddWaiverReference",
  "runId", "reviewer", "freshContext", "admissionId", "diffFingerprint", "sha256", "hash",
  "policyReference", "userMessageEntryId", "statusReference", "completeDiffReference", "source",
  "nextGate", "blockers", "status", "to", "inspectionId", "adapter", "adapterVersion", "redactionStatus",
  "retentionClass", "expiresAt", "capturedAt", "decidedAt", "artifactReferences", "result",
]);

function workflowObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workflowText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${field} must be a bounded nonempty string.`);
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) throw new Error(`${field} exceeds its bounded size.`);
  return normalized;
}

function workflowStringArray(value: unknown, field: string, required = true): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > 64) throw new Error(`${field} must be a bounded nonempty array.`);
  const values = value.map((entry, index) => workflowText(entry, `${field}[${index}]`, 4 * 1024));
  if (new Set(values).size !== values.length) throw new Error(`${field} contains duplicates.`);
  return values;
}

function workflowIsoNow(now?: () => string): string {
  const value = now ? now() : new Date().toISOString();
  const parsed = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Trusted workflow clock returned a non-canonical timestamp.");
  }
  return value;
}

function workflowArtifact(value: unknown): string | BoundedEvidenceReference | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return workflowText(value, "compensatingEvidence", 4 * 1024);
  if (!workflowObject(value) || typeof value.id !== "string") throw new Error("Evidence reference must be a bounded ID or reference object.");
  const output: BoundedEvidenceReference = { id: workflowText(value.id, "artifactReference.id", 256) };
  for (const [key, entry] of Object.entries(value)) {
    if (!["id", "kind", "label", "source", "sha256", "bytes", "createdAt", "expiresAt", "retentionClass"].includes(key)) throw new Error("Evidence reference contains an unsupported field.");
    if (entry === undefined || key === "id") continue;
    if (key === "bytes") {
      if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0 || entry > 2 * 1024 * 1024) throw new Error("artifactReference.bytes must be a bounded integer.");
      output.bytes = entry;
      continue;
    }
    if (key === "retentionClass") {
      if (entry !== "session" && entry !== "review" && entry !== "durable") throw new Error("artifactReference.retentionClass is invalid.");
      output.retentionClass = entry;
      continue;
    }
    const fieldValue = workflowText(entry, `artifactReference.${key}`, key === "source" ? 4 * 1024 : 1024);
    if (key === "kind") output.kind = fieldValue;
    else if (key === "label") output.label = fieldValue;
    else if (key === "source") output.source = fieldValue;
    else if (key === "sha256") {
      if (!/^[0-9a-f]{64}$/u.test(fieldValue)) throw new Error("artifactReference.sha256 must be a SHA-256 digest.");
      output.sha256 = fieldValue;
    } else if (key === "createdAt") output.createdAt = fieldValue;
    else if (key === "expiresAt") output.expiresAt = fieldValue;
  }
  return output;
}

function looksLikeSetupOrIrrelevantFailure(value: string): boolean {
  // The caller supplies only bounded observation facts; it cannot make this
  // controller execute a command to classify the result. Reject the common,
  // unambiguous setup/harness/unrelated markers rather than accepting them as
  // an intended missing-behavior red.
  return /(?:\bsetup\s+failure\b|\bunrelated(?:\s+\w+){0,3}\s+(?:failure|error|test|assertion)\b|cannot\s+find\s+(?:module|package)|module\s+not\s+found|command\s+not\s+found|syntax\s+error|parse\s+error|permission\s+denied|dependency\s+(?:missing|unavailable)|test\s+harness|fixture\s+(?:error|failure)|network\s+(?:error|failure)|timed?\s*out|\b(?:ENOENT|EACCES|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b|cannot\s+(?:locate|load)\s+(?:module|package)|invalid\s+test\s+configuration)/iu.test(value);
}

function assertNoWorkflowAuthorityFields(value: Record<string, unknown>): void {
  for (const field of Object.keys(value)) {
    if (WORKFLOW_ACTOR_FIELDS.has(field)) throw new Error(`Workflow input cannot supply authority field ${field}.`);
  }
}

function assertWorkflowActionFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  const permitted = new Set(["action", ...allowed]);
  for (const field of Object.keys(value)) {
    if (!permitted.has(field)) throw new Error(`Workflow field ${field} is not valid for this action.`);
  }
}

function workflowGateReference(value: unknown, field: string): string | BoundedEvidenceReference {
  if (typeof value === "string") return workflowText(value, field, 4 * 1024);
  if (!workflowObject(value)) throw new Error(`${field} must be a bounded evidence reference.`);
  return workflowArtifact(value) ?? (() => { throw new Error(`${field} must be a bounded evidence reference.`); })();
}

function workflowIndependentChecks(value: unknown): IndependentCheck[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new Error("independentChecks must contain at least one bounded check.");
  return value.map((raw, index) => {
    if (!workflowObject(raw) || Object.keys(raw).some((key) => !["id", "command", "result", "evidenceReference"].includes(key))) {
      throw new Error(`independentChecks[${index}] is malformed.`);
    }
    const result = raw.result;
    if (result !== "passed" && result !== "failed") throw new Error(`independentChecks[${index}].result is invalid.`);
    return {
      id: workflowText(raw.id, `independentChecks[${index}].id`, 256),
      command: workflowText(raw.command, `independentChecks[${index}].command`, 8 * 1024),
      result,
      evidenceReference: workflowGateReference(raw.evidenceReference, `independentChecks[${index}].evidenceReference`),
    };
  });
}

function workflowFindingList(value: unknown): ScaleFinding[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("findings must be a bounded array.");
  return value.map((raw, index) => {
    if (!workflowObject(raw) || Object.keys(raw).some((key) => !["id", "classification", "evidenceReference", "summary"].includes(key))) {
      throw new Error(`findings[${index}] is malformed.`);
    }
    if (raw.classification !== "blocker" && raw.classification !== "fix-now" && raw.classification !== "optional") throw new Error(`findings[${index}].classification is invalid.`);
    return {
      id: workflowText(raw.id, `findings[${index}].id`, 256),
      classification: raw.classification,
      evidenceReference: workflowGateReference(raw.evidenceReference, `findings[${index}].evidenceReference`),
      summary: workflowText(raw.summary, `findings[${index}].summary`, 8 * 1024),
    };
  });
}

const SCALE_POLICY_MAX_BYTES = 64 * 1024;
const SCALE_POLICY_KEYS = new Set(["workItemId", "scope", "reason", "riskLimit", "owner", "compensatingEvidence", "expiresAt", "reviewAt"]);

interface ParsedScalePolicy {
  scope: string | string[];
  reason: string;
  riskLimit: string;
  owner: string;
  compensatingEvidence: string | BoundedEvidenceReference;
  expiresAt: string;
  reviewAt: string;
  policyReference: BoundedEvidenceReference;
}

function readScalePolicy(policyPath: unknown, cwd: string, workItemId: string, stampedAt: string): ParsedScalePolicy {
  const normalizedPath = normalizeCheckoutPath(workflowText(policyPath, "policyPath", 4 * 1024), cwd, "policyPath");
  if (normalizedPath === ".") throw new Error("policyPath must identify a checkout-relative regular file.");
  const root = realpathSync(cwd);
  const absolute = resolve(root, normalizedPath);
  let content: Buffer;
  try {
    const link = lstatSync(absolute);
    if (link.isSymbolicLink() || !link.isFile() || link.size > SCALE_POLICY_MAX_BYTES) throw new Error("unsafe policy file");
    const canonical = realpathSync(absolute);
    if (canonical !== absolute) throw new Error("symlink policy file");
    content = readFileSync(absolute);
    if (content.byteLength > SCALE_POLICY_MAX_BYTES) throw new Error("oversized policy file");
  } catch {
    throw new Error("Scale policy must be a bounded, checkout-relative, non-symlink regular JSON file.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(content.toString("utf8")) as unknown; } catch { throw new Error("Scale policy is not valid JSON."); }
  if (!workflowObject(parsed) || !hasExactKeys(parsed, SCALE_POLICY_KEYS)
    || parsed.workItemId !== workItemId
    || parsed.expiresAt === undefined) {
    throw new Error("Scale policy must exactly match the current work item and required waiver fields.");
  }
  const scope = Array.isArray(parsed.scope)
    ? workflowStringArray(parsed.scope, "policy.scope")
    : workflowText(parsed.scope, "policy.scope", 4 * 1024);
  const reason = workflowText(parsed.reason, "policy.reason", 8 * 1024);
  const riskLimit = workflowText(parsed.riskLimit, "policy.riskLimit", 4 * 1024);
  const owner = workflowText(parsed.owner, "policy.owner", 1 * 1024);
  const compensatingEvidence = workflowGateReference(parsed.compensatingEvidence, "policy.compensatingEvidence");
  const expiresAt = workflowText(parsed.expiresAt, "policy.expiresAt", 128);
  const reviewAt = parsed.reviewAt === undefined ? expiresAt : workflowText(parsed.reviewAt, "policy.reviewAt", 128);
  const expiry = Date.parse(expiresAt);
  const review = Date.parse(reviewAt);
  const stamp = Date.parse(stampedAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(expiresAt)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(reviewAt)
    || !Number.isFinite(expiry) || !Number.isFinite(review) || !Number.isFinite(stamp)
    || expiry <= stamp || review <= stamp) {
    throw new Error("Scale policy expiry and review timestamps must be canonical and in the future.");
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  return {
    scope, reason, riskLimit, owner, compensatingEvidence, expiresAt, reviewAt,
    policyReference: {
      id: `scale-policy-${sha256.slice(0, 24)}`,
      kind: "scale-waiver-policy",
      label: "trusted Scale waiver policy",
      source: normalizedPath,
      sha256,
      bytes: content.byteLength,
      createdAt: stampedAt,
      expiresAt,
    },
  };
}

function hasExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === new Set(keys).size && keys.every((key) => allowed.has(key));
}

function userMessageText(entry: unknown): string | undefined {
  if (!workflowObject(entry) || entry.type !== "message" || !workflowObject(entry.message) || entry.message.role !== "user") return undefined;
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  let text = "";
  for (const part of content) {
    if (!workflowObject(part) || part.type !== "text" || typeof part.text !== "string") return undefined;
    text += part.text;
  }
  return text;
}

function findScaleWaiverMessage(manager: LedgerSessionManager, workItemId: string): { entryId: string } {
  const expected = `WAIVE SCALE: ${workItemId}`;
  let branch: readonly unknown[];
  try { branch = manager.getBranch(); } catch { throw new Error("Unable to read the active branch for user Scale-waiver provenance."); }
  let matching: { entryId: string } | undefined;
  for (const raw of branch) {
    const value = userMessageText(raw);
    if (value !== expected) continue;
    if (!workflowObject(raw) || typeof raw.id !== "string" || !raw.id.trim()) continue;
    matching = { entryId: raw.id };
  }
  if (!matching) throw new Error(`Scale waiver requires the exact active-branch user message '${expected}'.`);
  for (const raw of branch) {
    if (!workflowObject(raw) || raw.type !== "custom" || raw.customType !== LEDGER_CUSTOM_TYPE || !workflowObject(raw.data)) continue;
    const data = raw.data;
    const candidate = workflowObject(data.scaleWaiver) ? data.scaleWaiver : workflowObject(data.record) ? data.record.scaleWaiver : undefined;
    if (workflowObject(candidate) && candidate.userMessageEntryId === matching.entryId) {
      throw new Error("The exact user Scale-waiver message has already been consumed.");
    }
  }
  return matching;
}

const MATRIX_CHECK_INPUT_KEYS = new Set(["id", "surface", "method", "requirementIds", "interaction", "scenario", "expectedOutcome"]);
const MATRIX_DECISION_INPUT_KEYS = new Set(["surface", "requirementIds", "applicability", "reason"]);
const MATRIX_EVIDENCE_INPUT_KEYS = new Set([
  "acceptanceCheckId", "checkId", "checkSpecId", "surface", "method", "requirementIds", "scenario", "interaction", "invocation", "environment", "controlledEnvironment", "observedResult", "observedOutcome",
  "result", "artifactInputPaths", "artifactPaths", "retentionClass",
]);

function matrixSurface(value: unknown): value is InterfaceSurface {
  return typeof value === "string" && (INTERFACE_SURFACES as readonly string[]).includes(value);
}

function matrixMethod(value: unknown): value is InterfaceEvidenceMethod {
  return typeof value === "string" && (Object.values(INTERFACE_METHOD_BY_SURFACE) as readonly string[]).includes(value);
}

function matrixInputList(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) throw new Error(`${field} must be a bounded nonempty array.`);
  return value;
}

function matrixInputIds(value: unknown, requirements: readonly string[], field: string): string[] {
  const ids = workflowStringArray(value, field);
  if (!ids.every((id) => requirements.includes(id))) throw new Error(`${field} must contain only declared requirement IDs.`);
  return ids;
}

function matrixInputObject(raw: unknown, allowed: ReadonlySet<string>, field: string): Record<string, unknown> {
  if (!workflowObject(raw) || Object.keys(raw).some((key) => !allowed.has(key))) throw new Error(`${field} contains authority or unsupported fields.`);
  return raw;
}

function matrixCheckSpecs(value: unknown, requirements: readonly string[]): AcceptanceCheckSpec[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("acceptanceCheckSpecs must be a bounded array.");
  const entries = value;
  const ids = new Set<string>();
  return entries.map((raw, index) => {
    const item = matrixInputObject(raw, MATRIX_CHECK_INPUT_KEYS, `acceptanceCheckSpecs[${index}]`);
    const id = workflowText(item.id, `acceptanceCheckSpecs[${index}].id`, 256);
    if (ids.has(id)) throw new Error("Acceptance check spec IDs must be unique.");
    ids.add(id);
    const surface = item.surface;
    if (!matrixSurface(surface)) throw new Error(`acceptanceCheckSpecs[${index}].surface is invalid.`);
    if (!matrixMethod(item.method) || item.method !== INTERFACE_METHOD_BY_SURFACE[surface]) throw new Error(`acceptanceCheckSpecs[${index}].method must be the canonical method for its surface.`);
    const requirementIds = matrixInputIds(item.requirementIds, requirements, `acceptanceCheckSpecs[${index}].requirementIds`);
    const interaction = workflowText(item.interaction, `acceptanceCheckSpecs[${index}].interaction`, 8 * 1024);
    const scenario = item.scenario === undefined ? undefined : workflowText(item.scenario, `acceptanceCheckSpecs[${index}].scenario`, 8 * 1024);
    const expectedOutcome = item.expectedOutcome === undefined ? undefined : workflowText(item.expectedOutcome, `acceptanceCheckSpecs[${index}].expectedOutcome`, 8 * 1024);
    return { id, surface, method: item.method, requirementIds, interaction, ...(scenario !== undefined ? { scenario } : {}), ...(expectedOutcome !== undefined ? { expectedOutcome } : {}) };
  });
}

function matrixDecisions(value: unknown, requirements: readonly string[], inspectionId: string, diffFingerprint: string, timestamp: string): EvidenceApplicabilityDecision[] {
  const entries = matrixInputList(value, "applicabilityDecisions");
  return entries.map((raw, index) => {
    const item = matrixInputObject(raw, MATRIX_DECISION_INPUT_KEYS, `applicabilityDecisions[${index}]`);
    if (!matrixSurface(item.surface)) throw new Error(`applicabilityDecisions[${index}].surface is invalid.`);
    if (item.applicability !== "applicable" && item.applicability !== "not-applicable") throw new Error(`applicabilityDecisions[${index}].applicability is invalid.`);
    return {
      surface: item.surface,
      requirementIds: matrixInputIds(item.requirementIds, requirements, `applicabilityDecisions[${index}].requirementIds`),
      applicability: item.applicability,
      reason: workflowText(item.reason, `applicabilityDecisions[${index}].reason`, 4 * 1024),
      actor: "Primary" as const,
      decidedAt: timestamp,
      inspectionId,
      diffFingerprint,
    };
  });
}

interface MatrixEvidenceInput {
  acceptanceCheckId: string;
  surface: InterfaceSurface;
  method: InterfaceEvidenceMethod;
  requirementIds: string[];
  scenario: string;
  invocation: string;
  environment: string;
  observedResult: string;
  result: "passed" | "failed" | "blocked";
  artifactInputPaths: string[];
  retentionClass: "session" | "review" | "durable";
}

function matrixEvidenceInputs(value: unknown, requirements: readonly string[]): MatrixEvidenceInput[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error("interfaceEvidence must be a bounded array.");
  const entries = value;
  return entries.map((raw, index) => {
    const item = matrixInputObject(raw, MATRIX_EVIDENCE_INPUT_KEYS, `interfaceEvidence[${index}]`);
    const pathsValue = item.artifactInputPaths ?? item.artifactPaths;
    if (item.artifactInputPaths !== undefined && item.artifactPaths !== undefined) throw new Error("Supply only artifactInputPaths or artifactPaths.");
    const paths = workflowStringArray(pathsValue, `interfaceEvidence[${index}].artifactInputPaths`);
    if (!matrixSurface(item.surface)) throw new Error(`interfaceEvidence[${index}].surface is invalid.`);
    if (!matrixMethod(item.method) || item.method !== INTERFACE_METHOD_BY_SURFACE[item.surface]) throw new Error(`interfaceEvidence[${index}].method must be the canonical method for its surface.`);
    const acceptanceCheckId = workflowText(item.acceptanceCheckId ?? item.checkId ?? item.checkSpecId, `interfaceEvidence[${index}].acceptanceCheckId`, 256);
    const requirementIds = matrixInputIds(item.requirementIds, requirements, `interfaceEvidence[${index}].requirementIds`);
    const scenario = workflowText(item.scenario ?? item.interaction, `interfaceEvidence[${index}].scenario`, 8 * 1024);
    const invocation = workflowText(item.invocation ?? item.interaction, `interfaceEvidence[${index}].invocation`, 8 * 1024);
    const environment = workflowText(item.environment ?? item.controlledEnvironment, `interfaceEvidence[${index}].environment`, 8 * 1024);
    const observedResult = workflowText(item.observedResult ?? item.observedOutcome, `interfaceEvidence[${index}].observedResult`, 16 * 1024);
    const result = item.result;
    if (result !== "passed" && result !== "failed" && result !== "blocked") throw new Error(`interfaceEvidence[${index}].result is invalid.`);
    const retentionClass = item.retentionClass;
    if (retentionClass !== undefined && retentionClass !== "session" && retentionClass !== "review" && retentionClass !== "durable") throw new Error(`interfaceEvidence[${index}].retentionClass is invalid.`);
    return { acceptanceCheckId, surface: item.surface, method: item.method, requirementIds, scenario, invocation, environment, observedResult, result, artifactInputPaths: paths, retentionClass: retentionClass ?? "session" };
  });
}

function evidenceArtifactReferences(records: readonly InterfaceEvidenceRecord[]): BoundedEvidenceReference[] {
  return records.flatMap((record) => record.artifactReferences.filter((reference): reference is BoundedEvidenceReference => typeof reference !== "string"));
}

export interface PrimaryWorkflowControllerDependencies {
  pi: LedgerAppender;
  getSessionManager(): LedgerSessionManager | undefined;
  getWorkflowRecord(): WorkflowRecord | undefined;
  setWorkflowRecord(record: WorkflowRecord): void;
  cwd(): string;
  now?(): string;
  /** Trusted mode seam for the exact latest completed Scale run. */
  getLatestScaleRun?(): { runId: string; admissionId?: string; faculty: "scale"; state: "complete" | "failed" | "stopped" | "rejected" | "timed_out" } | undefined;
  /** Trusted checkout capture; artifacts live only in an OS-temp directory. */
  captureInspectionArtifacts?(cwd: string, now?: Date): CapturedInspectionArtifacts;
  /** Reverify both retained artifact identities and the live checkout snapshot. */
  verifyInspectionArtifacts?(cwd: string, inspection: PrimaryInspection): boolean;
}

export interface WorkflowActionResult {
  workItemId: string;
  phase: WorkflowPhase;
  entryId: string;
}

/**
 * Trusted normal-runtime Primary workflow authoring. This controller is kept
 * separate from godmode_delegate: all callers provide only bounded packet or
 * observation facts, while actor, hashes, timestamps, transitions, and
 * persistence lineage are supplied by this implementation.
 */
export function createPrimaryWorkflowController(deps: PrimaryWorkflowControllerDependencies) {
  const append = (record: WorkflowRecord, timestamp: string): { entryId: string; record: WorkflowRecord } => {
    const manager = deps.getSessionManager();
    if (!manager) throw new Error("Workflow authoring requires an active SessionManager.");
    // appendWorkflowSnapshot performs the exact active-leaf acknowledgement;
    // the in-memory callback is deliberately after this call. Use the
    // acknowledged sanitized record so raw excerpts never become runtime
    // authority/context merely because this closure retained its input.
    const persisted = appendWorkflowSnapshot(deps.pi, manager, record, timestamp);
    return { entryId: persisted.entryId, record: persisted.snapshot.record };
  };
  const commit = (record: WorkflowRecord, timestamp: string): WorkflowActionResult => {
    const persisted = append(record, timestamp);
    deps.setWorkflowRecord(persisted.record);
    return { workItemId: persisted.record.workItemId, phase: persisted.record.phase, entryId: persisted.entryId };
  };

  const specify = (input: Record<string, unknown>): WorkflowActionResult => {
    assertWorkflowActionFields(input, ["workItemId", "classification", "goal", "requirementIds", "functionalRequirements", "nonGoals", "expectedPaths", "roadmap", "acceptanceChecks", "authorityConstraints"]);
    if (deps.getWorkflowRecord() !== undefined) throw new Error("A workflow packet already exists; replacement or reclassification is rejected.");
    const manager = deps.getSessionManager();
    if (!manager) throw new Error("Workflow authoring requires an active SessionManager.");
    try {
      for (const entry of manager.getBranch()) {
        if (entry.type === "custom" && entry.customType === LEDGER_CUSTOM_TYPE) {
          throw new Error("A persisted workflow packet or malformed ledger entry already exists; replacement or recovery bypass is rejected.");
        }
      }
    } catch (error) {
      if (error instanceof Error && /persisted workflow packet/iu.test(error.message)) throw error;
      throw new Error("Unable to prove that no prior workflow packet exists; authoring is blocked.");
    }
    const workItemId = workflowText(input.workItemId, "workItemId", 1024);
    const classification = input.classification;
    if (!["feature", "bugfix", "refactor/maintenance", "documentation/configuration", "test-only/tooling"].includes(classification as string)) {
      throw new Error("classification is invalid or missing.");
    }
    const goal = workflowText(input.goal, "goal", 32 * 1024);
    const requirementIds = workflowStringArray(input.requirementIds, "requirementIds");
    if (!requirementIds.every((id) => WORKFLOW_REQUIREMENT_ID.test(id))) throw new Error("requirementIds must be numbered FR-N identifiers.");
    const functionalRequirements: FunctionalRequirement[] = [];
    if (!Array.isArray(input.functionalRequirements) || input.functionalRequirements.length === 0 || input.functionalRequirements.length > 64) {
      throw new Error("functionalRequirements must contain actual numbered descriptions and interfaces.");
    }
    const functionalIds = new Set<string>();
    for (const [index, raw] of input.functionalRequirements.entries()) {
      if (!workflowObject(raw) || Object.keys(raw).length !== 3 || typeof raw.id !== "string") throw new Error(`functionalRequirements[${index}] is malformed.`);
      const id = workflowText(raw.id, `functionalRequirements[${index}].id`, 64);
      const description = workflowText(raw.description, `functionalRequirements[${index}].description`, 8 * 1024);
      const iface = workflowText(raw.interface, `functionalRequirements[${index}].interface`, 4 * 1024);
      if (!WORKFLOW_REQUIREMENT_ID.test(id) || functionalIds.has(id) || description === id || iface === id) throw new Error("functionalRequirements must contain actual descriptions and interfaces, not only IDs.");
      functionalIds.add(id);
      functionalRequirements.push({ id, description, interface: iface });
    }
    if (functionalIds.size !== requirementIds.length || !requirementIds.every((id) => functionalIds.has(id))) {
      throw new Error("functionalRequirements must exactly agree with requirementIds.");
    }
    const nonGoals = workflowStringArray(input.nonGoals, "nonGoals");
    const rawPaths = workflowStringArray(input.expectedPaths, "expectedPaths");
    const expectedPaths = rawPaths.map((path, index) => normalizeCheckoutPath(path, deps.cwd(), `expectedPaths[${index}]`));
    if (new Set(expectedPaths).size !== expectedPaths.length) throw new Error("expectedPaths contains duplicate normalized paths.");
    if (!Array.isArray(input.roadmap) || input.roadmap.length === 0 || input.roadmap.length > 64) throw new Error("roadmap must be bounded and cover every requirement.");
    const roadmap = input.roadmap.map((raw, index) => {
      if (!workflowObject(raw) || Object.keys(raw).length !== 3) throw new Error(`roadmap[${index}] is malformed or contains authority fields.`);
      const id = workflowText(raw.id, `roadmap[${index}].id`, 256);
      const itemRequirements = workflowStringArray(raw.requirementIds, `roadmap[${index}].requirementIds`);
      if (!itemRequirements.every((requirementId) => requirementIds.includes(requirementId))) throw new Error("roadmap references an undeclared requirement.");
      return { id, requirementIds: itemRequirements, title: workflowText(raw.title, `roadmap[${index}].title`, 4 * 1024), status: "pending" as const };
    });
    if (new Set(roadmap.map((item) => item.id)).size !== roadmap.length) throw new Error("roadmap contains duplicate item IDs.");
    if (!requirementIds.every((id) => roadmap.some((item) => item.requirementIds.includes(id)))) throw new Error("roadmap must cover every requirement.");
    const acceptanceChecks = workflowStringArray(input.acceptanceChecks, "acceptanceChecks");
    const authorityConstraints = workflowStringArray(input.authorityConstraints, "authorityConstraints");
    const timestamp = workflowIsoNow(deps.now);
    let record: WorkflowRecord = {
      workItemId,
      classification: classification as WorkflowClassification,
      goal,
      requirementIds,
      functionalRequirements,
      nonGoals,
      expectedPaths,
      phase: "draft",
      roadmap,
      history: [],
      nextGate: "classification",
      blockers: [],
      residualRisks: [],
      evidence: [],
      completionCapsulePolicy: "required-v1",
      packetAuthor: "Primary",
      acceptanceChecks,
      authorityConstraints,
      // Every newly authored packet opts into the interface-matched gate.
      // Legacy records recovered from older ledgers remain compatible because
      // they do not receive this additive policy during reconstruction.
      interfaceEvidencePolicy: "interface-matched-v1" as const,
    };
    for (const to of ["classified", "specified", "red-test-ready"] as const) {
      record = applyPhaseTransition(record, {
        to,
        actor: "Primary",
        timestamp,
        reason: to === "classified" ? "Primary classified the fresh work item." : to === "specified" ? "Primary authored the complete specification packet." : "Primary prepared the intended-red/TDD gate.",
        reference: `workflow:${workItemId}:${to}`,
      });
    }
    record.nextGate = "red-test-observed-or-tdd-waived";
    return commit(record, timestamp);
  };

  const recordRed = (input: Record<string, unknown>): WorkflowActionResult => {
    if (input.redTest !== undefined) {
      if (!workflowObject(input.redTest)) throw new Error("redTest observation is malformed.");
      const { redTest: _nested, ...rest } = input;
      if (Object.keys(input.redTest).some((key) => Object.hasOwn(rest, key))) throw new Error("Red observation fields must be supplied either nested or flat, not both.");
      return recordRed({ ...rest, ...input.redTest });
    }
    assertWorkflowActionFields(input, ["workItemId", "testPath", "command", "environment", "exitStatus", "failureKind", "requirementIds", "outputExcerpt", "artifactReference"]);
    const current = deps.getWorkflowRecord();
    if (!current) throw new Error("Cannot record red evidence without a prior workflow packet.");
    const validation = validateWorkflowRecord(current);
    if (!validation.ok) throw new Error(`Cannot record red evidence from blocked workflow state: ${validation.reason}`);
    if (input.workItemId !== undefined && input.workItemId !== current.workItemId) throw new Error("Conflicting work-item identity is rejected.");
    if (input.classification !== undefined && input.classification !== current.classification) throw new Error("Workflow reclassification is rejected.");
    if (current.phase !== "red-test-ready") throw new Error(`Recording intended red requires red-test-ready phase; current phase is ${current.phase}.`);
    if (current.redTestEvidence !== undefined || current.tddWaiver !== undefined || current.redTestReference !== undefined || current.tddWaiverReference !== undefined) throw new Error("The red/TDD gate already has evidence; replacement is rejected.");
    if (input.failureKind !== "missing-behavior") throw new Error("Only an intended missing-behavior failure can open the red gate; setup or unrelated failures are rejected.");
    const command = workflowText(input.command, "command", 8 * 1024);
    const environment = workflowText(input.environment, "environment", 4 * 1024);
    const testPath = normalizeCheckoutPath(workflowText(input.testPath, "testPath", 4 * 1024), deps.cwd(), "testPath");
    const exitStatus = input.exitStatus;
    if (typeof exitStatus !== "number" || !Number.isSafeInteger(exitStatus) || exitStatus === 0) throw new Error("An observed red result requires a nonzero integer exitStatus.");
    const requirementIds = workflowStringArray(input.requirementIds, "requirementIds");
    if (!sameStringSetLocal(requirementIds, current.requirementIds)) throw new Error("Red evidence must cover exactly every packet requirement.");
    const outputExcerpt = input.outputExcerpt === undefined ? undefined : workflowText(input.outputExcerpt, "outputExcerpt", 8 * 1024);
    const artifactReference = workflowArtifact(input.artifactReference);
    if (outputExcerpt === undefined && artifactReference === undefined) throw new Error("Red evidence requires a bounded output excerpt or artifact reference.");
    if (outputExcerpt !== undefined && looksLikeSetupOrIrrelevantFailure(outputExcerpt)) {
      throw new Error("The observed failure looks like setup, harness, or unrelated failure evidence rather than missing behavior.");
    }
    if (!current.expectedPaths.includes(testPath)) throw new Error("Referenced red test must be included in packet expectedPaths.");
    const absolute = realpathSync(resolveForWorkflow(deps.cwd(), testPath));
    const root = realpathSync(deps.cwd());
    const fileStats = statSync(absolute);
    if (pathEscapesLocal(root, absolute) || !lstatSync(absolute).isFile() || !fileStats.isFile() || fileStats.size > 1024 * 1024) throw new Error("Referenced red test must be a bounded regular checkout file.");
    const content = readFileSync(absolute);
    const testContentHash = createHash("sha256").update(content).digest("hex");
    if (!verifyRedTestIdentity(deps.cwd(), { path: testPath, hash: testContentHash })) throw new Error("Referenced red test is missing a meaningful non-skipped assertion or failed checkout integrity checks.");
    const observedAt = workflowIsoNow(deps.now);
    const redTestEvidence = {
      id: `red-${testContentHash.slice(0, 24)}`,
      command,
      environment,
      exitStatus,
      requirementIds: [...requirementIds],
      testPath,
      testContentHash,
      observedBy: "Primary" as const,
      observedAt,
      failureKind: "missing-behavior" as const,
      ...(outputExcerpt !== undefined ? { outputExcerpt } : {}),
      ...(artifactReference !== undefined ? { artifactReference } : {}),
    };
    let record = applyPhaseTransition(current, {
      to: "red-test-observed",
      actor: "Primary",
      timestamp: observedAt,
      reason: "Primary observed an intended missing-behavior red result from the checkout.",
      reference: `evidence:${redTestEvidence.id}`,
    });
    record.redTestEvidence = redTestEvidence;
    record.redTestReference = redTestEvidence.id;
    record.nextGate = "hand-running";
    // Revalidate after attaching the authority-bearing evidence before append.
    const postValidation = validateWorkflowRecord(record);
    if (!postValidation.ok) throw new Error(`Red evidence is malformed: ${postValidation.reason}`);
    return commit(postValidation.record, observedAt);
  };

  const waiveTdd = (input: Record<string, unknown>): WorkflowActionResult => {
    if (input.waiver !== undefined) {
      if (!workflowObject(input.waiver)) throw new Error("waiver input is malformed.");
      const { waiver: _nested, ...rest } = input;
      if (Object.keys(input.waiver).some((key) => Object.hasOwn(rest, key))) throw new Error("Waiver fields must be supplied either nested or flat, not both.");
      return waiveTdd({ ...rest, ...input.waiver });
    }
    assertWorkflowActionFields(input, ["workItemId", "requirementIds", "inapplicableSeam", "reason", "scope", "compensatingCheck", "compensatingEvidence"]);
    const current = deps.getWorkflowRecord();
    if (!current) throw new Error("Cannot record a TDD waiver without a prior workflow packet.");
    const validation = validateWorkflowRecord(current);
    if (!validation.ok) throw new Error(`Cannot waive TDD from blocked workflow state: ${validation.reason}`);
    if (input.workItemId !== undefined && input.workItemId !== current.workItemId) throw new Error("Conflicting work-item identity is rejected.");
    if (current.phase !== "red-test-ready") throw new Error(`TDD waiver requires red-test-ready phase; current phase is ${current.phase}.`);
    if (current.redTestEvidence !== undefined || current.tddWaiver !== undefined || current.redTestReference !== undefined || current.tddWaiverReference !== undefined) throw new Error("The red/TDD gate already has evidence; replacement is rejected.");
    const requirementIds = workflowStringArray(input.requirementIds, "requirementIds");
    if (!sameStringSetLocal(requirementIds, current.requirementIds)) throw new Error("TDD waiver must cover exactly every packet requirement.");
    const inapplicableSeam = workflowText(input.inapplicableSeam, "inapplicableSeam", 4 * 1024);
    const reason = workflowText(input.reason, "reason", 8 * 1024);
    const scope = Array.isArray(input.scope)
      ? workflowStringArray(input.scope, "scope")
      : workflowText(input.scope, "scope", 4 * 1024);
    const compensatingCheck = input.compensatingCheck === undefined ? undefined : workflowText(input.compensatingCheck, "compensatingCheck", 8 * 1024);
    const compensatingEvidence = workflowArtifact(input.compensatingEvidence);
    if (compensatingCheck === undefined && compensatingEvidence === undefined) throw new Error("A TDD waiver requires a compensating check or evidence.");
    const timestamp = workflowIsoNow(deps.now);
    const waiver = {
      id: `tdd-${timestamp.replace(/\D/gu, "").slice(0, 17)}`,
      item: current.workItemId,
      requirementIds: [...requirementIds],
      inapplicableSeam,
      reason,
      actor: "Primary" as const,
      approver: "Primary" as const,
      date: timestamp,
      scope,
      ...(compensatingCheck !== undefined ? { compensatingCheck } : {}),
      ...(compensatingEvidence !== undefined ? { compensatingEvidence } : {}),
    };
    if (!validateTddWaiver(waiver, current.requirementIds, current.classification)) throw new Error("TDD waiver is broad, unsafe, or lacks the required unavailable seam and compensation.");
    let record = applyPhaseTransition(current, {
      to: "tdd-waived",
      actor: "Primary",
      timestamp,
      reason: "Primary recorded a narrow gate-specific TDD waiver.",
      reference: `decision:${waiver.id}`,
    });
    record.tddWaiver = waiver;
    record.tddWaiverReference = waiver.id;
    record.nextGate = "hand-running";
    const postValidation = validateWorkflowRecord(record);
    if (!postValidation.ok) throw new Error(`TDD waiver is malformed: ${postValidation.reason}`);
    return commit(postValidation.record, timestamp);
  };

  const recordInspection = (input: Record<string, unknown>): WorkflowActionResult => {
    if (input.inspection !== undefined) {
      if (!workflowObject(input.inspection)) throw new Error("inspection input is malformed.");
      const { inspection: _nested, ...rest } = input;
      if (Object.keys(input.inspection).some((key) => Object.hasOwn(rest, key))) throw new Error("Inspection fields must be supplied either nested or flat, not both.");
      return recordInspection({ ...rest, ...input.inspection });
    }
    assertWorkflowActionFields(input, ["workItemId", "materiallyChangedPaths", "outOfScopeChanges", "independentChecks", "residualRisks", "settleRoadmapItemIds", "roadmapItemIds"]);
    const current = deps.getWorkflowRecord();
    if (!current) throw new Error("Cannot record Primary inspection without a prior workflow packet.");
    const validation = validateWorkflowRecord(current);
    if (!validation.ok) throw new Error(`Cannot record Primary inspection from blocked workflow state: ${validation.reason}`);
    if (input.workItemId !== undefined && input.workItemId !== current.workItemId) throw new Error("Conflicting work-item identity is rejected.");
    if (current.phase !== "hand-handoff" && current.phase !== "primary-verifying") throw new Error(`Primary inspection requires hand-handoff or primary-verifying phase; current phase is ${current.phase}.`);
    if (current.primaryInspection !== undefined && current.phase !== "primary-verifying") throw new Error("A current Primary inspection already exists; remediation or an explicit reverify phase must invalidate it before reinspection.");
    if (input.materiallyChangedPaths === undefined) throw new Error("Primary inspection must classify every captured changed path as material or out of scope.");
    const inspectedAt = workflowIsoNow(deps.now);
    const capture = deps.captureInspectionArtifacts ?? captureInspectionArtifacts;
    let captured: CapturedInspectionArtifacts | undefined;
    try {
      captured = capture(deps.cwd(), new Date(inspectedAt));
    const rawPaths = workflowStringArray(input.materiallyChangedPaths, "materiallyChangedPaths", false);
    const materiallyChangedPaths = rawPaths.map((path, index) => normalizeCheckoutPath(path, deps.cwd(), `materiallyChangedPaths[${index}]`));
    if (new Set(materiallyChangedPaths).size !== materiallyChangedPaths.length) throw new Error("materiallyChangedPaths contains duplicate normalized paths.");
    const outOfScopeRaw = input.outOfScopeChanges === undefined ? [] : input.outOfScopeChanges;
    if (!Array.isArray(outOfScopeRaw) || outOfScopeRaw.length > 64) throw new Error("outOfScopeChanges must be a bounded array.");
    const outOfScopeChanges = outOfScopeRaw.map((raw, index) => {
      if (!workflowObject(raw) || Object.keys(raw).some((key) => !["path", "disposition"].includes(key))) throw new Error(`outOfScopeChanges[${index}] is malformed.`);
      return {
        path: normalizeCheckoutPath(workflowText(raw.path, `outOfScopeChanges[${index}].path`, 4 * 1024), deps.cwd(), `outOfScopeChanges[${index}].path`),
        disposition: workflowText(raw.disposition, `outOfScopeChanges[${index}].disposition`, 4 * 1024),
      };
    });
    if (new Set(outOfScopeChanges.map((entry) => entry.path)).size !== outOfScopeChanges.length) throw new Error("outOfScopeChanges contains duplicate paths.");
    const independentChecks = workflowIndependentChecks(input.independentChecks);
    const packetChecks = current.acceptanceChecks;
    if (!packetChecks || independentChecks.length !== packetChecks.length
      || new Set(independentChecks.map((check) => check.command)).size !== independentChecks.length
      || !independentChecks.every((check) => packetChecks.includes(check.command))
      || !packetChecks.every((command) => independentChecks.some((check) => check.command === command))) {
      throw new Error("Primary inspection independent checks must exactly cover every packet acceptance check without duplicates or substitutions.");
    }
    if (!independentChecks.every((check) => check.result === "passed")) {
      throw new Error("Primary inspection requires every packet acceptance check to pass with evidence.");
    }
    const residualRisks = input.residualRisks === undefined ? [] : workflowStringArray(input.residualRisks, "residualRisks", false);
    const capturedPaths = [...captured.changedPaths];
    const classifiedPaths = [...materiallyChangedPaths, ...outOfScopeChanges.map((entry) => entry.path)];
    if (new Set(classifiedPaths).size !== classifiedPaths.length
      || capturedPaths.length !== classifiedPaths.length
      || !capturedPaths.every((path) => classifiedPaths.includes(path))
      || !classifiedPaths.every((path) => capturedPaths.includes(path))) {
      throw new Error("Primary inspection material/out-of-scope classifications must exactly partition the captured changed paths.");
    }
    const inspection: PrimaryInspection = {
      id: `inspection-${captured.fingerprint.slice(0, 24)}`,
      actor: "Primary",
      inspectedAt,
      statusReference: captured.statusReference,
      completeDiffReference: captured.completeDiffReference,
      diffFingerprint: captured.fingerprint,
      materiallyChangedPaths,
      outOfScopeChanges,
      independentChecks,
      residualRisks,
    };
    if (!validatePrimaryInspection(inspection, packetChecks)) throw new Error("Primary inspection is incomplete, malformed, or does not exactly cover passing packet acceptance checks.");
    const previousMatrixArtifacts = evidenceArtifactReferences(current.interfaceEvidence ?? []);
    let next = {
      ...current,
      primaryInspection: inspection,
      // Reinspection after blocked recovery invalidates every current gate
      // bound to the replaced fingerprint, including Phase 4 artifacts.
      ...(current.primaryInspection !== undefined ? {
        scaleReview: undefined,
        scaleWaiver: undefined,
        scaleVerdict: undefined,
        scaleWaiverReference: undefined,
      } : {}),
      ...(current.interfaceEvidence !== undefined ? {
        acceptanceCheckSpecs: undefined,
        applicabilityDecisions: undefined,
        interfaceEvidence: undefined,
        evidence: current.evidence.filter((reference) => !previousMatrixArtifacts.some((artifact) => artifact.id === reference.id)),
      } : {}),
      scaleAdmission: undefined,
      residualRisks: [...new Set([...current.residualRisks, ...inspection.residualRisks])],
    } as WorkflowRecord;
    const settleInput = input.settleRoadmapItemIds ?? input.roadmapItemIds;
    if (input.settleRoadmapItemIds !== undefined && input.roadmapItemIds !== undefined) throw new Error("Supply only one roadmap settlement list.");
    const settleIds = settleInput === undefined ? [] : workflowStringArray(settleInput, "settleRoadmapItemIds");
    for (const itemId of settleIds) {
      const item = next.roadmap.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error(`Unknown roadmap item ${itemId}.`);
      if (item.status === "pending") {
        // The Primary may first record that the inspected implementation is
        // present, then independently settle it. This is still restricted to
        // the explicitly supplied item IDs and requires the passed check gate.
        next = applyRoadmapTransition(next, itemId, {
          to: "implemented-unverified",
          actor: "Primary",
          timestamp: inspection.inspectedAt,
          reason: "Primary observed the implementation during complete inspection; verification follows independent checks.",
          reference: `inspection:${inspection.id}:implementation`,
        });
      }
      if (next.roadmap.find((candidate) => candidate.id === itemId)?.status !== "implemented-unverified") {
        throw new Error(`Roadmap item ${itemId} is not ready for Primary verification; evidence cannot settle already-settled state.`);
      }
      next = applyRoadmapTransition(next, itemId, {
        to: "verified",
        actor: "Primary",
        timestamp: inspection.inspectedAt,
        reason: "Primary independently verified the implemented roadmap item during complete inspection.",
        reference: `inspection:${inspection.id}`,
      });
    }
    if (next.phase === "hand-handoff") {
      next = applyPhaseTransition(next, {
        to: "primary-verifying", actor: "Primary", timestamp: inspection.inspectedAt,
        reason: "Primary began complete checkout inspection after Hand handoff.", reference: `inspection:${inspection.id}:begin`,
      });
    }
    next = applyPhaseTransition(next, {
      to: "evidence-ready", actor: "Primary", timestamp: inspection.inspectedAt,
      reason: "Primary completed the full diff, changed-path, out-of-scope, and independent-check inspection.", reference: `inspection:${inspection.id}`,
    });
    next.nextGate = next.interfaceEvidencePolicy === "interface-matched-v1"
      ? "interface-evidence"
      : "scale-review-or-waiver";
    const result = commit(next, inspection.inspectedAt);
    if (current.primaryInspection !== undefined) cleanupInspectionArtifacts(current.primaryInspection);
    if (previousMatrixArtifacts.length > 0) cleanupEvidenceArtifacts(previousMatrixArtifacts);
    return result;
    } catch (error) {
      if (captured !== undefined) cleanupInspectionArtifactDirectory(captured.artifactDirectory);
      throw error;
    }
  };

  const recordEvidence = (input: Record<string, unknown>): WorkflowActionResult => {
    assertWorkflowActionFields(input, [
      "workItemId", "acceptanceCheckSpecs", "applicabilityDecisions", "interfaceEvidence", "evidenceRecords", "records", "observations", "checks", "decisions",
    ]);
    const current = deps.getWorkflowRecord();
    if (!current) throw new Error("Cannot record interface evidence without a prior workflow packet.");
    const validation = validateWorkflowRecord(current);
    if (!validation.ok) throw new Error(`Cannot record interface evidence from blocked workflow state: ${validation.reason}`);
    if (input.workItemId !== undefined && input.workItemId !== current.workItemId) throw new Error("Conflicting work-item identity is rejected.");
    if (current.phase !== "evidence-ready") throw new Error(`Interface evidence requires evidence-ready phase; current phase is ${current.phase}.`);
    if (!current.primaryInspection || !validatePrimaryInspection(current.primaryInspection, current.acceptanceChecks)) {
      throw new Error("Interface evidence requires a complete current Primary inspection.");
    }
    const verifyInspection = deps.verifyInspectionArtifacts
      ?? ((cwd: string, inspection: PrimaryInspection) => verifyInspectionArtifacts(cwd, inspection));
    if (!verifyInspection(deps.cwd(), current.primaryInspection)) {
      throw new Error("Interface evidence requires fresh, untampered inspection artifacts and an unchanged checkout.");
    }
    const timestamp = workflowIsoNow(deps.now);
    const existingMatrix = current.acceptanceCheckSpecs !== undefined
      || current.applicabilityDecisions !== undefined
      || current.interfaceEvidence !== undefined;
    // A passing, fresh current matrix is immutable for this inspection.
    // Failed, blocked, tampered, or expired evidence may be retried, but the
    // replacement remains bound to the same inspection and is only committed
    // after ledger acknowledgement.
    let currentMatrixPasses = validateInterfaceEvidenceMatrix(current);
    if (currentMatrixPasses) {
      const currentReferences = (current.interfaceEvidence ?? []).flatMap((evidence) => evidence.artifactReferences);
      const currentArtifacts = currentReferences.filter((reference): reference is BoundedEvidenceReference => typeof reference === "object" && reference !== null);
      currentMatrixPasses = currentArtifacts.length === currentReferences.length
        && (currentArtifacts.length === 0 || verifyEvidenceArtifacts(currentArtifacts, new Date(timestamp)));
    }
    if (existingMatrix && currentMatrixPasses) {
      throw new Error("A passing current interface evidence matrix already exists; replacement is rejected.");
    }
    const previousMatrixArtifacts = evidenceArtifactReferences(current.interfaceEvidence ?? []);
    const previousMatrixArtifactIds = new Set(previousMatrixArtifacts.map((artifact) => artifact.id));
    const rawChecks = input.acceptanceCheckSpecs ?? input.checks;
    const rawDecisions = input.applicabilityDecisions ?? input.decisions;
    const rawEvidence = input.interfaceEvidence ?? input.evidenceRecords ?? input.records ?? input.observations;
    if (input.acceptanceCheckSpecs !== undefined && input.checks !== undefined) throw new Error("Supply only acceptanceCheckSpecs or checks.");
    if (input.applicabilityDecisions !== undefined && input.decisions !== undefined) throw new Error("Supply only applicabilityDecisions or decisions.");
    if ([input.interfaceEvidence, input.evidenceRecords, input.records, input.observations].filter((value) => value !== undefined).length > 1) throw new Error("Supply only one interface evidence records field.");
    const inspection = current.primaryInspection;
    const checkSpecs = matrixCheckSpecs(rawChecks, current.requirementIds);
    const decisions = matrixDecisions(rawDecisions, current.requirementIds, inspection.id, inspection.diffFingerprint, timestamp);
    const evidenceInputs = matrixEvidenceInputs(rawEvidence, current.requirementIds);
    const retentionClasses = new Set(evidenceInputs.map((record) => record.retentionClass));
    if (retentionClasses.size > 1) throw new Error("One nonempty interface evidence matrix must use one consistent retentionClass for every imported artifact and record.");
    const allPaths = evidenceInputs.flatMap((record) => record.artifactInputPaths);
    // Import only explicit paths supplied in the bounded action payload. No
    // command, browser, process, network, or discovered path is executed.
    const imported = allPaths.length === 0
      ? { artifacts: [] as EvidenceArtifactDescriptor[], directory: undefined, totalBytes: 0 }
      : importEvidenceArtifacts(allPaths, {
        cwd: deps.cwd(),
        now: new Date(timestamp),
        expiresAt: new Date(Date.parse(timestamp) + EVIDENCE_ARTIFACT_TTL_MS).toISOString(),
        retentionClass: evidenceInputs[0]?.retentionClass ?? "session",
      });
    let cursor = 0;
    try {
      const evidenceRecords: InterfaceEvidenceRecord[] = evidenceInputs.map((inputRecord, index) => {
        const artifactReferences = imported.artifacts.slice(cursor, cursor + inputRecord.artifactInputPaths.length);
        cursor += inputRecord.artifactInputPaths.length;
        if (artifactReferences.length !== inputRecord.artifactInputPaths.length) throw new Error("Evidence artifact import count does not match supplied records.");
        const contentIdentity = artifactReferences.map((reference) => reference.id).join("-");
        // Include the prior current record identities so a retry creates a
        // distinct historical snapshot even when the same source content is
        // supplied again.
        const priorIdentity = (current.interfaceEvidence ?? []).map((evidence) => evidence.id).join("|");
        return {
          id: `interface-evidence-${inspection.id}-${index}-${createHash("sha256").update(`${contentIdentity}|${priorIdentity}`).digest("hex").slice(0, 16)}`,
          workItemId: current.workItemId,
          requirementIds: [...inputRecord.requirementIds],
          surface: inputRecord.surface,
          method: inputRecord.method,
          acceptanceCheckId: inputRecord.acceptanceCheckId,
          scenario: inputRecord.scenario,
          invocation: inputRecord.invocation,
          environment: inputRecord.environment,
          observedResult: inputRecord.observedResult,
          artifactReferences,
          result: inputRecord.result,
          actor: "Primary",
          capturedAt: timestamp,
          adapter: "primary-observed-artifact",
          adapterVersion: "1",
          redactionStatus: "verified-clean",
          retentionClass: inputRecord.retentionClass,
          expiresAt: imported.artifacts[cursor - 1]?.expiresAt ?? new Date(Date.parse(timestamp) + EVIDENCE_ARTIFACT_TTL_MS).toISOString(),
          inspectionId: inspection.id,
          diffFingerprint: inspection.diffFingerprint,
        };
      });
      const next = {
        ...current,
        interfaceEvidencePolicy: "interface-matched-v1" as const,
        acceptanceCheckSpecs: checkSpecs,
        applicabilityDecisions: decisions,
        interfaceEvidence: evidenceRecords,
        // Generic evidence is the active projection. Keep historical matrix
        // snapshots in the append-only ledger, but remove superseded matrix
        // descriptors from this current projection before adding the retry.
        evidence: [
          ...current.evidence.filter((reference) => !previousMatrixArtifactIds.has(reference.id)),
          ...imported.artifacts,
        ],
        nextGate: "scale-review-or-waiver",
      } as WorkflowRecord;
      const matrixValidation = validateInterfaceEvidenceMatrixDetailed(next, { requirePassing: false });
      if (!matrixValidation.ok) throw new Error(`Interface evidence matrix is incomplete or invalid: ${matrixValidation.reason ?? "unknown matrix error"}`);
      next.nextGate = validateInterfaceEvidenceMatrix(next) ? "scale-review-or-waiver" : "interface-evidence";
      const result = commit(next, timestamp);
      // The old artifacts are no longer active only after append acknowledgement
      // succeeds. If append fails, the previous current snapshot remains intact.
      if (previousMatrixArtifacts.length > 0) cleanupEvidenceArtifacts(previousMatrixArtifacts);
      return result;
    } catch (error) {
      if (imported.directory !== undefined) cleanupEvidenceArtifacts(imported.directory);
      throw error;
    }
  };

  const recordScaleReview = (input: Record<string, unknown>): WorkflowActionResult => {
    if (input.scaleReview !== undefined) {
      if (!workflowObject(input.scaleReview)) throw new Error("scaleReview input is malformed.");
      const { scaleReview: _nested, ...rest } = input;
      if (Object.keys(input.scaleReview).some((key) => Object.hasOwn(rest, key))) throw new Error("Scale review fields must be supplied either nested or flat, not both.");
      return recordScaleReview({ ...rest, ...input.scaleReview });
    }
    assertWorkflowActionFields(input, ["workItemId", "evidenceReferences", "verdict", "findings", "residualUncertainty", "correctionScope", "remediationPaths"]);
    const current = deps.getWorkflowRecord();
    if (!current) throw new Error("Cannot record Scale review without a prior workflow packet.");
    const validation = validateWorkflowRecord(current);
    if (!validation.ok) throw new Error(`Cannot record Scale review from blocked workflow state: ${validation.reason}`);
    if (input.workItemId !== undefined && input.workItemId !== current.workItemId) throw new Error("Conflicting work-item identity is rejected.");
    if (current.phase !== "scale-running") throw new Error(`Scale review requires scale-running phase; current phase is ${current.phase}.`);
    if (current.scaleReview !== undefined) throw new Error("A Scale review already exists for this Scale admission; a fresh Scale run is required.");
    const admission = current.scaleAdmission;
    if (!admission || !admission.boundRunId) throw new Error("Scale review requires an append-acknowledged bound Scale admission and run.");
    const latest = deps.getLatestScaleRun?.();
    if (!latest || latest.faculty !== "scale" || latest.state !== "complete"
      || latest.admissionId !== admission.admissionId || latest.runId !== admission.boundRunId) {
      throw new Error("Scale review must bind to the exact latest completed Scale run and current admission; no caller-supplied run identity is accepted.");
    }
    const verify = deps.verifyInspectionArtifacts ?? ((cwd: string, inspection: PrimaryInspection) => verifyInspectionArtifacts(cwd, inspection));
    if (!current.primaryInspection || !verify(deps.cwd(), current.primaryInspection)) {
      throw new Error("Scale review requires fresh, untampered inspection artifacts and an unchanged checkout.");
    }
    const evidenceClock = new Date(workflowIsoNow(deps.now));
    if (requiresInterfaceEvidence(current)) {
      if (!validateInterfaceEvidenceMatrix(current)) throw new Error(`Scale review requires passing current interface evidence: ${validateInterfaceEvidenceMatrixDetailed(current).reason ?? "matrix incomplete"}`);
      const matrixReferences = (current.interfaceEvidence ?? []).flatMap((evidence) => evidence.artifactReferences);
      const matrixArtifacts = matrixReferences.filter((reference): reference is BoundedEvidenceReference => typeof reference === "object" && reference !== null);
      if (matrixArtifacts.length !== matrixReferences.length || (matrixArtifacts.length > 0 && !verifyEvidenceArtifacts(matrixArtifacts, evidenceClock))) throw new Error("Scale review requires fresh, present, untampered imported interface evidence artifacts.");
    }
    const previousAttempt = current.remediation?.attempt ?? 0;
    const evidenceReferences = input.evidenceReferences === undefined ? [] : input.evidenceReferences;
    if (!Array.isArray(evidenceReferences) || evidenceReferences.length === 0 || evidenceReferences.length > 64) throw new Error("evidenceReferences must be a bounded nonempty array.");
    const normalizedEvidence = evidenceReferences.map((entry, index) => workflowGateReference(entry, `evidenceReferences[${index}]`));
    const verdict = input.verdict;
    if (verdict !== "pass" && verdict !== "changes-required") throw new Error("Scale review verdict must be pass or changes-required.");
    if (verdict === "pass" && requiresInterfaceEvidence(current)) {
      const suppliedReferences = new Set(normalizedEvidence.map((reference) => typeof reference === "string" ? reference : reference.id));
      const matrixReferences = (current.interfaceEvidence ?? [])
        .flatMap((evidence) => evidence.artifactReferences)
        .map((reference) => typeof reference === "string" ? reference : reference.id);
      if (!matrixReferences.every((reference) => suppliedReferences.has(reference))) {
        throw new Error("A passing Scale review must reference every current interface evidence artifact.");
      }
    }
    const findings = workflowFindingList(input.findings ?? []);
    const residualUncertainty = workflowText(input.residualUncertainty, "residualUncertainty", 8 * 1024);
    if (!current.primaryInspection) throw new Error("Scale review requires the current Primary inspection.");
    const correctionInput = input.correctionScope;
    const remediationInput = input.remediationPaths;
    if (correctionInput !== undefined && remediationInput !== undefined) {
      throw new Error("Supply only one correctionScope or remediationPaths field.");
    }
    const scopeInput = correctionInput ?? remediationInput;
    if (verdict === "pass" && scopeInput !== undefined) {
      throw new Error("A passing Scale review cannot supply correctionScope.");
    }
    let correctionScope: string[] | undefined;
    if (verdict === "changes-required") {
      if (previousAttempt >= MAX_REMEDIATION_ATTEMPTS) throw new Error(`Remediation is capped at ${MAX_REMEDIATION_ATTEMPTS} correction attempts.`);
      if (scopeInput === undefined) throw new Error("A changes-required Scale review requires a nonempty correctionScope of packet paths.");
      const rawScope = workflowStringArray(scopeInput, "correctionScope");
      correctionScope = rawScope.map((path, index) => normalizeCheckoutPath(path, deps.cwd(), `correctionScope[${index}]`));
      if (new Set(correctionScope).size !== correctionScope.length) throw new Error("correctionScope contains duplicate normalized paths.");
      const packetPaths = current.expectedPaths.map((path, index) => normalizeCheckoutPath(path, deps.cwd(), `packet.expectedPaths[${index}]`));
      if (!isBoundedSubsetLocal(correctionScope, packetPaths)) {
        throw new Error("correctionScope must be a nonempty subset of packet expectedPaths.");
      }
    }
    const completedAt = workflowIsoNow(deps.now);
    const review: ScaleReview = {
      id: `scale-review-${admission.admissionId}-${latest.runId}`,
      runId: latest.runId,
      admissionId: admission.admissionId,
      reviewer: "Scale",
      completedAt,
      freshContext: true,
      diffFingerprint: current.primaryInspection.diffFingerprint,
      evidenceReferences: normalizedEvidence,
      verdict,
      findings,
      residualUncertainty,
    };
    if (!validateScaleReview(review, current.primaryInspection)) throw new Error("Scale review is stale, summary-only, malformed, or not bound to the current inspection.");
    let next = {
      ...current,
      scaleReview: review,
      scaleVerdict: verdict,
      residualRisks: [...new Set([
        ...current.residualRisks,
        ...findings.filter((finding) => finding.classification === "optional").map((finding) => finding.summary),
      ])],
    } as WorkflowRecord;
    if (verdict === "pass") {
      next = applyPhaseTransition(next, {
        to: "review-passed", actor: "Primary", timestamp: completedAt,
        reason: "Primary recorded the exact completed Scale run's passing review.", reference: `scale-review:${review.id}`,
      });
      next.nextGate = "primary-acceptance";
    } else {
      // Scope is caller-provided and path-normalized above; prose findings
      // remain linked evidence but never become mutation authority.
      if (!correctionScope) throw new Error("A changes-required Scale review requires a bounded correction scope.");
      next = applyPhaseTransition(next, {
        to: "remediation", actor: "Primary", timestamp: completedAt,
        reason: "Scale found blocker or fix-now findings requiring bounded remediation.", reference: `scale-review:${review.id}`,
        correctionScope,
      });
      next.nextGate = "hand-correction";
    }
    return commit(next, completedAt);
  };

  const waiveScale = (input: Record<string, unknown>): WorkflowActionResult => {
    if (input.scaleWaiver !== undefined) {
      if (!workflowObject(input.scaleWaiver)) throw new Error("scaleWaiver input is malformed.");
      const { scaleWaiver: _nested, ...rest } = input;
      if (Object.keys(input.scaleWaiver).some((key) => Object.hasOwn(rest, key))) throw new Error("Scale waiver fields must be supplied either nested or flat, not both.");
      return waiveScale({ ...rest, ...input.scaleWaiver });
    }
    assertWorkflowActionFields(input, ["workItemId", "basis", "scope", "reason", "riskLimit", "compensatingEvidence", "policyPath"]);
    const current = deps.getWorkflowRecord();
    if (!current) throw new Error("Cannot record Scale waiver without a prior workflow packet.");
    const validation = validateWorkflowRecord(current);
    if (!validation.ok) throw new Error(`Cannot record Scale waiver from blocked workflow state: ${validation.reason}`);
    if (input.workItemId !== undefined && input.workItemId !== current.workItemId) throw new Error("Conflicting work-item identity is rejected.");
    if (current.phase !== "evidence-ready") throw new Error(`Scale waiver requires evidence-ready phase; current phase is ${current.phase}.`);
    if (current.scaleWaiver !== undefined || current.scaleReview !== undefined) throw new Error("A current Scale waiver or review already exists; replacement is rejected.");
    if (!current.primaryInspection) throw new Error("Scale waiver never bypasses Primary inspection.");
    const timestamp = workflowIsoNow(deps.now);
    if (requiresInterfaceEvidence(current)) {
      if (!validateInterfaceEvidenceMatrix(current)) throw new Error(`Scale waiver requires complete current interface evidence: ${validateInterfaceEvidenceMatrixDetailed(current).reason ?? "matrix incomplete"}`);
      const matrixReferences = (current.interfaceEvidence ?? []).flatMap((evidence) => evidence.artifactReferences);
      const matrixArtifacts = matrixReferences.filter((reference): reference is BoundedEvidenceReference => typeof reference === "object" && reference !== null);
      if (matrixArtifacts.length !== matrixReferences.length || (matrixArtifacts.length > 0 && !verifyEvidenceArtifacts(matrixArtifacts, new Date(timestamp)))) throw new Error("Scale waiver requires fresh, present, untampered imported interface evidence artifacts.");
    }
    const basis = input.basis;
    if (basis !== "user-explicit" && basis !== "policy") throw new Error("Scale waiver basis must be user-explicit or policy.");
    let waiver: ScaleWaiver;
    if (basis === "user-explicit") {
      if (input.policyPath !== undefined) throw new Error("A user-explicit Scale waiver cannot supply policyPath.");
      const manager = deps.getSessionManager();
      if (!manager) throw new Error("Scale waiver requires an active session branch for user-message provenance.");
      const userMessage = findScaleWaiverMessage(manager, current.workItemId);
      waiver = {
        id: `scale-waiver-${timestamp.replace(/\\D/gu, "").slice(0, 17)}`,
        item: current.workItemId,
        basis,
        actor: "Primary",
        approver: "Primary",
        date: timestamp,
        scope: Array.isArray(input.scope) ? workflowStringArray(input.scope, "scope") : workflowText(input.scope, "scope", 4 * 1024),
        reason: workflowText(input.reason, "reason", 8 * 1024),
        riskLimit: workflowText(input.riskLimit, "riskLimit", 4 * 1024),
        compensatingEvidence: workflowGateReference(input.compensatingEvidence, "compensatingEvidence"),
        userMessageEntryId: userMessage.entryId,
      };
    } else {
      if (input.scope !== undefined || input.reason !== undefined || input.riskLimit !== undefined || input.compensatingEvidence !== undefined) {
        throw new Error("Policy waiver scope, reason, risk, and compensation must come only from the strict policy file.");
      }
      const policy = readScalePolicy(input.policyPath, deps.cwd(), current.workItemId, timestamp);
      waiver = {
        id: `scale-waiver-${policy.policyReference.id.slice(-24)}`,
        item: current.workItemId,
        basis,
        actor: "Primary",
        approver: "Primary",
        date: timestamp,
        scope: policy.scope,
        reason: policy.reason,
        riskLimit: policy.riskLimit,
        compensatingEvidence: policy.compensatingEvidence,
        policyReference: policy.policyReference,
        owner: policy.owner,
        expiresAt: policy.expiresAt,
        reviewAt: policy.reviewAt,
      };
    }
    if (!validateScaleWaiver(waiver, current.workItemId)) throw new Error("Scale waiver is broad, unsafe, uncompensated, or lacks the required provenance/policy controls.");
    let next = { ...current, scaleWaiver: waiver, scaleWaiverReference: waiver.id } as WorkflowRecord;
    next = applyPhaseTransition(next, {
      to: "scale-waived", actor: "Primary", timestamp,
      reason: "Primary recorded a narrow compensated Scale waiver without bypassing inspection.", reference: `decision:${waiver.id}`,
    });
    next.nextGate = "primary-acceptance";
    return commit(next, timestamp);
  };

  const accept = (input: Record<string, unknown>): WorkflowActionResult => {
    assertWorkflowActionFields(input, ["workItemId", "reason"]);
    const current = deps.getWorkflowRecord();
    if (!current) throw new Error("Cannot accept without a prior workflow packet.");
    const validation = validateWorkflowRecord(current);
    if (!validation.ok) throw new Error(`Cannot accept blocked workflow state: ${validation.reason}`);
    if (input.workItemId !== undefined && input.workItemId !== current.workItemId) throw new Error("Conflicting work-item identity is rejected.");
    if (!current.primaryInspection) throw new Error("Acceptance requires the current Primary inspection.");
    const timestamp = workflowIsoNow(deps.now);
    if (requiresInterfaceEvidence(current)) {
      if (!validateInterfaceEvidenceMatrix(current)) throw new Error(`Acceptance requires complete current interface evidence: ${validateInterfaceEvidenceMatrixDetailed(current).reason ?? "matrix incomplete"}`);
      const matrixReferences = (current.interfaceEvidence ?? []).flatMap((evidence) => evidence.artifactReferences);
      const matrixArtifacts = matrixReferences.filter((reference): reference is BoundedEvidenceReference => typeof reference === "object" && reference !== null);
      if (matrixArtifacts.length !== matrixReferences.length || (matrixArtifacts.length > 0 && !verifyEvidenceArtifacts(matrixArtifacts, new Date(timestamp)))) throw new Error("Acceptance requires fresh, present, untampered imported interface evidence artifacts.");
    }
    const verify = deps.verifyInspectionArtifacts ?? ((cwd: string, inspection: PrimaryInspection) => verifyInspectionArtifacts(cwd, inspection));
    if (!verify(deps.cwd(), current.primaryInspection)) throw new Error("Acceptance requires fresh, untampered inspection artifacts and an unchanged checkout.");
    if (current.scaleWaiver?.basis === "policy") {
      const expiry = Date.parse(current.scaleWaiver.expiresAt ?? current.scaleWaiver.reviewAt ?? "");
      const review = Date.parse(current.scaleWaiver.reviewAt ?? current.scaleWaiver.expiresAt ?? "");
      if (!Number.isFinite(expiry) || !Number.isFinite(review) || expiry <= Date.parse(timestamp) || review <= Date.parse(timestamp)) {
        throw new Error("Acceptance requires an unexpired Scale policy waiver and review date.");
      }
    }
    const reason = input.reason === undefined ? "Primary accepted after the current Scale gate." : workflowText(input.reason, "reason", 8 * 1024);
    const matrixArtifacts = (current.interfaceEvidence ?? []).flatMap((evidence) => evidence.artifactReferences.filter((reference): reference is BoundedEvidenceReference => typeof reference === "object" && reference !== null));
    // Build the capsule from the fully gated accepted record, then append the
    // accepted record plus capsule exactly once. No pre-capsule accepted state
    // is committed or exposed to recovery.
    const accepted = applyPhaseTransition(current, {
      to: "accepted", actor: "Primary", timestamp, reason, reference: `accept:${current.workItemId}`,
    });
    const completionCapsule = createCompletionCapsule(accepted, timestamp, timestamp);
    const acceptedWithCapsule: WorkflowRecord = {
      ...accepted,
      completionCapsulePolicy: "required-v1",
      completionCapsule,
      latestCapsuleReference: completionCapsuleReference(completionCapsule),
    };
    const capsuleValidation = validateWorkflowRecord(acceptedWithCapsule);
    if (!capsuleValidation.ok) throw new Error(`Acceptance completion capsule is malformed: ${capsuleValidation.reason}`);
    const result = commit(capsuleValidation.record, timestamp);
    cleanupInspectionArtifacts(current.primaryInspection);
    if (matrixArtifacts.length > 0) cleanupEvidenceArtifacts(matrixArtifacts);
    return result;
  };

  return {
    execute(params: WorkflowParams | Record<string, unknown>): WorkflowActionResult {
      if (!workflowObject(params)) throw new Error("Workflow input must be an object.");
      assertNoWorkflowAuthorityFields(params);
      const action = params.action;
      if (action === "specify") return specify(params);
      if (action === "record-red") return recordRed(params);
      if (action === "waive-tdd") return waiveTdd(params);
      if (action === "record-inspection") return recordInspection(params);
      if (action === "record-evidence" || action === "record-evidence-matrix") return recordEvidence(params);
      if (action === "record-scale-review") return recordScaleReview(params);
      if (action === "waive-scale") return waiveScale(params);
      if (action === "accept") return accept(params);
      throw new Error("Workflow action must be specify, record-red, waive-tdd, record-inspection, record-evidence, record-scale-review, waive-scale, or accept.");
    },
  };
}

function sameStringSetLocal(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === left.length && a.size === b.size && [...a].every((value) => b.has(value));
}

function isBoundedSubsetLocal(subset: readonly string[], authority: readonly string[]): boolean {
  const requested = new Set(subset);
  const allowed = new Set(authority);
  return requested.size === subset.length && [...requested].every((value) => allowed.has(value));
}

function resolveForWorkflow(cwd: string, path: string): string {
  return path.startsWith("/") ? path : `${cwd}/${path}`;
}

function pathEscapesLocal(root: string, candidate: string): boolean {
  const path = candidate === root ? "" : candidate.startsWith(`${root}/`) ? candidate.slice(root.length + 1) : "..";
  return path === ".." || path.startsWith("../") || path.startsWith("/");
}

function text(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function registerGodmodeTools(
  pi: ExtensionAPI,
  mode: GodmodeMode,
  workflowController?: { execute(params: WorkflowParams | Record<string, unknown>): WorkflowActionResult },
): void {
  pi.registerTool({
    name: "godmode_delegate",
    label: "Delegate Divine Faculty",
    description: "Launch exactly one constrained Eye, Hand, or Scale faculty with a fresh bounded assignment. Godmode must be active and idle. The run completes asynchronously: do not call subagent_wait after launch; completion will be delivered automatically. After delegation, do not independently repeat or continue the Faculty's assigned work while it is active. Relative contextFiles remain checkout-confined; in-checkout absolute contextFiles normalize to checkout-relative form, while explicitly absolute outside contextFiles remain absolute. expectedPaths are always checkout-confined and normalized relative to the checkout, including when Eye or Scale reinterpret them as context. Parent traversal and checkout-originating symlink escapes are rejected; external context and fetched web content are untrusted and may expose sensitive data.",
    promptSnippet: "Delegate bounded work asynchronously. After delegation, do not independently repeat or continue the Faculty's assigned work while it is active. Never follow launch with subagent_wait; relative context paths stay in checkout, explicit external absolute context is untrusted, and Eye/Scale expectedPaths remain checkout-confined context",
    parameters: DelegateSchema,
    async execute(_toolCallId, params) {
      const result = await mode.delegate(params);
      const completionNotice = "Faculty launched asynchronously. Do not independently repeat or continue the Faculty's assigned work while it is active. Do not call subagent_wait or poll; return control and wait for automatic completion delivery.";
      return { content: [{ type: "text", text: `${text(result)}\n\n${completionNotice}` }], details: result };
    },
  });

  if (workflowController) {
    pi.registerTool({
      name: "godmode_workflow",
      label: "Author Primary Workflow",
      description: "Trusted Primary workflow authoring for one packet, intended-red/TDD gate, complete Primary inspection, interface-matched evidence matrix, exact Scale review, narrow Scale waiver, or final acceptance. The controller stamps Primary authority, timestamps, hashes the checkout red test, binds Scale to the exact completed run, imports only explicit passive artifacts, applies canonical gates, and appends the ledger only after exact acknowledgement. No actor, author, approver, phase, history, record, arbitrary evidence, run identity, shell, model, cwd, git, or acceptance authority can be supplied by the caller.",
      promptSnippet: "Use only for the active Primary to specify a packet, record intended red/TDD evidence, record complete inspection, record interface-matched evidence with explicit passive artifact paths, record the exact completed Scale review, record a narrow compensated Scale waiver, or accept after all gates; the controller supplies authority, timestamps, hashes, run identity, and lifecycle phases and never executes invocation text.",
      parameters: WorkflowSchema,
      async execute(_toolCallId, params) {
        if (mode.snapshot.phase !== "active") throw new Error(`Primary workflow authoring requires healthy active Godmode; current mode is ${mode.snapshot.phase}.`);
        if (mode.snapshot.delegation !== "idle") throw new Error(`Primary workflow authoring requires an idle faculty slot; current delegation is ${mode.snapshot.delegation}.`);
        const result = workflowController.execute(params);
        return { content: [{ type: "text", text: text(result) }], details: result };
      },
    });
  }

  pi.registerTool({
    name: "godmode_control",
    label: "Control Divine Faculty",
    description: "Inspect, steer, stop, or grant one bounded extension to the sole Godmode faculty. No child ID is selectable. A configured faculty timeout is a soft deadline: after it, the Faculty is asked to checkpoint after its current tool, and the Primary may grant at most one extension of up to five minutes before the finite hard deadline. Automatic completion delivery is the default. Never call godmode_control status merely to check whether a queued or running faculty has finished. Use godmode_control status only when the user explicitly requests a snapshot, when recovering unknown session state, or when diagnosing a genuinely missing completion or inconsistent state. Repeated status calls waste tokens.",
    promptSnippet: "Control the sole Divine Faculty. Configured timeout is a soft deadline; after it, inspect deadline-pending status and grant at most one bounded extension only when warranted. Automatic completion delivery is the default. Never call godmode_control status merely to check whether a queued or running faculty has finished. Use godmode_control status only when the user explicitly requests a snapshot, when recovering unknown session state, or when diagnosing a genuinely missing completion or inconsistent state. Repeated status calls waste tokens.",
    parameters: ControlSchema,
    async execute(_toolCallId, params) {
      if (params.action === "status") {
        if (params.message !== undefined || params.reason !== undefined || params.extensionMs !== undefined) throw new Error("godmode_control status accepts only action.");
        const snapshot = mode.snapshot.activeRun?.runId ? await mode.status() : mode.snapshot;
        const result = boundedStatus(snapshot);
        return { content: [{ type: "text", text: text(result) }], details: result };
      }
      if (params.action === "steer") {
        if (!params.message?.trim() || params.reason !== undefined || params.extensionMs !== undefined) throw new Error("godmode_control steer requires message and rejects reason/extensionMs.");
        const result = boundedStatus(await mode.steer(params.message));
        return { content: [{ type: "text", text: text(result) }], details: result };
      }
      if (params.action === "extend") {
        if (params.message !== undefined || params.reason !== undefined || params.extensionMs === undefined) throw new Error("godmode_control extend requires extensionMs and rejects message/reason.");
        const result = boundedStatus(await mode.extend(params.extensionMs));
        return { content: [{ type: "text", text: text(result) }], details: result };
      }
      if (params.message !== undefined || params.extensionMs !== undefined) throw new Error("godmode_control stop rejects message/extensionMs; use optional reason.");
      const result = boundedStatus(await mode.stop(params.reason));
      return { content: [{ type: "text", text: text(result) }], details: result };
    },
  });
}
