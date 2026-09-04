import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { GodmodeMode } from "./mode.ts";
import {
  appendWorkflowSnapshot,
  LEDGER_CUSTOM_TYPE,
  type LedgerSessionManager,
  type LedgerAppender,
} from "./session-ledger.ts";
import {
  applyPhaseTransition,
  validateTddWaiver,
  validateWorkflowRecord,
} from "./workflow-state.ts";
import { normalizeCheckoutPath, verifyRedTestIdentity } from "./faculties.ts";
import type {
  FunctionalRequirement,
  BoundedEvidenceReference,
  WorkflowClassification,
  WorkflowPhase,
  WorkflowRecord,
} from "./types.ts";
import { MAX_SUPERVISOR_EXTENSION_MS } from "./deadlines.ts";
import { boundedStatus } from "./status.ts";

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
    source: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    createdAt: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    expiresAt: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
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

export const WorkflowSchema = Type.Object({
  action: StringEnum(["specify", "record-red", "waive-tdd"] as const),
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
  "nextGate", "blockers", "residualRisks", "status", "to",
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
    if (!["id", "kind", "label", "source", "createdAt", "expiresAt"].includes(key)) throw new Error("Evidence reference contains an unsupported field.");
    if (entry === undefined || key === "id") continue;
    const fieldValue = workflowText(entry, `artifactReference.${key}`, 1024);
    if (key === "kind") output.kind = fieldValue;
    else if (key === "label") output.label = fieldValue;
    else if (key === "source") output.source = fieldValue;
    else if (key === "createdAt") output.createdAt = fieldValue;
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

export interface PrimaryWorkflowControllerDependencies {
  pi: LedgerAppender;
  getSessionManager(): LedgerSessionManager | undefined;
  getWorkflowRecord(): WorkflowRecord | undefined;
  setWorkflowRecord(record: WorkflowRecord): void;
  cwd(): string;
  now?(): string;
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
      packetAuthor: "Primary",
      acceptanceChecks,
      authorityConstraints,
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

  return {
    execute(params: WorkflowParams | Record<string, unknown>): WorkflowActionResult {
      if (!workflowObject(params)) throw new Error("Workflow input must be an object.");
      assertNoWorkflowAuthorityFields(params);
      const action = params.action;
      if (action === "specify") return specify(params);
      if (action === "record-red") return recordRed(params);
      if (action === "waive-tdd") return waiveTdd(params);
      throw new Error("Workflow action must be specify, record-red, or waive-tdd.");
    },
  };
}

function sameStringSetLocal(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === left.length && a.size === b.size && [...a].every((value) => b.has(value));
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
      description: "Trusted Primary workflow authoring for one fresh packet, one observed intended-red result, or one narrow TDD waiver. The controller stamps Primary authority, timestamps, hashes the checkout red test, applies canonical transitions, and appends the ledger only after exact acknowledgement. It never accepts work. No actor, author, approver, phase, history, record, arbitrary evidence, shell, model, cwd, git, or acceptance authority can be supplied by the caller.",
      promptSnippet: "Use only for the active Primary to specify one fresh packet, record one observed missing-behavior red result, or record one narrow TDD waiver; the controller supplies authority, timestamps, hash, and lifecycle phases.",
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
