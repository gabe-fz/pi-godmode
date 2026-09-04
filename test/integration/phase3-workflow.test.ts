import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "node:test";
import { createPrimaryWorkflowController } from "../../src/tools.ts";
import { validateDelegation } from "../../src/faculties.ts";
import { applyPhaseTransition, validateWorkflowRecord } from "../../src/workflow-state.ts";
import { GodmodeMode } from "../../src/mode.ts";
import { ModelLease } from "../../src/model-lease.ts";
import { workflowRecord } from "../fixtures/workflow.ts";
import { validConfig } from "../fixtures/config.ts";
import type { ThinkingLevel, WorkflowRecord } from "../../src/types.ts";

const audit = {
  actor: "Primary" as const,
  timestamp: "2026-09-04T02:00:00.000Z",
  reason: "Controlled Phase 3 integration fixture.",
  reference: "evidence:phase3-integration",
};
const fingerprint = "a".repeat(64);

function toPrimaryVerifying(): WorkflowRecord {
  return ([
    "classified", "specified", "red-test-ready", "red-test-observed", "hand-running", "hand-handoff", "primary-verifying",
  ] as const).reduce((record, to) => applyPhaseTransition(record, { ...audit, to }), workflowRecord());
}

function withInspection(record: WorkflowRecord): WorkflowRecord {
  const directory = mkdtempSync(join(tmpdir(), "pi-godmode-inspection-"));
  const statusPath = join(directory, "status.bin");
  const diffPath = join(directory, "diff.bin");
  const status = Buffer.from("status-integration");
  const completeDiff = Buffer.from("diff-integration");
  writeFileSync(statusPath, status);
  writeFileSync(diffPath, completeDiff);
  return {
    ...record,
    primaryInspection: {
      id: "inspection-integration",
      actor: "Primary",
      inspectedAt: audit.timestamp,
      statusReference: { id: "artifact:status-integration", kind: "git-status", source: statusPath, sha256: createHash("sha256").update(status).digest("hex"), bytes: status.byteLength, createdAt: audit.timestamp, expiresAt: "2099-01-01T00:00:00.000Z" },
      completeDiffReference: { id: "artifact:diff-integration", kind: "git-complete-diff", source: diffPath, sha256: createHash("sha256").update(completeDiff).digest("hex"), bytes: completeDiff.byteLength, createdAt: audit.timestamp, expiresAt: "2099-01-01T00:00:00.000Z" },
      diffFingerprint: fingerprint,
      materiallyChangedPaths: ["src/workflow-state.ts"],
      outOfScopeChanges: [{ path: "notes.tmp", disposition: "investigated-generated-artifact" }],
      independentChecks: [{ id: "check-integration", command: "npm test", result: "passed", evidenceReference: "artifact:test-integration" }],
      residualRisks: [],
    },
  };
}

test("Phase 3 evidence-ready requires a complete Primary inspection", () => {
  const record = toPrimaryVerifying();
  assert.throws(() => applyPhaseTransition(record, { ...audit, to: "evidence-ready" }), /inspection/i);
  const inspected = applyPhaseTransition(withInspection(record), { ...audit, to: "evidence-ready" });
  assert.equal(inspected.phase, "evidence-ready");
});

test("Phase 3 rejects stale Scale fingerprints and accepts only classified findings", () => {
  const inspected = applyPhaseTransition(withInspection(toPrimaryVerifying()), { ...audit, to: "evidence-ready" });
  const stale = {
    ...inspected,
    scaleReview: {
      id: "scale-review-stale", runId: "run-stale", admissionId: "scale-admission-legacy", reviewer: "Scale" as const, completedAt: audit.timestamp,
      freshContext: true as const, diffFingerprint: "b".repeat(64), evidenceReferences: ["artifact:diff-integration"],
      verdict: "changes-required" as const,
      findings: [{ id: "finding", classification: "fix-now" as const, evidenceReference: "artifact:diff-integration", summary: "Correction required." }],
      residualUncertainty: "stale",
    },
  } as WorkflowRecord;
  assert.equal(validateWorkflowRecord(stale).ok, false);
});

test("Phase 3 remediation clears stale current acceptance evidence", () => {
  const inspected = applyPhaseTransition(withInspection(toPrimaryVerifying()), { ...audit, to: "evidence-ready" });
  const runningBase = applyPhaseTransition(inspected, { ...audit, to: "scale-running" });
  const running: WorkflowRecord = {
    ...runningBase,
    scaleAdmission: {
      admissionId: `scale-admission-${"c".repeat(64)}`, nonce: "c".repeat(64), workItemId: runningBase.workItemId,
      inspectionId: "inspection-integration", diffFingerprint: fingerprint, admittedAt: audit.timestamp, boundRunId: "run-blocked",
    },
    scaleReview: {
      id: "scale-review-blocked", runId: "run-blocked", admissionId: `scale-admission-${"c".repeat(64)}`, reviewer: "Scale", completedAt: audit.timestamp,
      freshContext: true, diffFingerprint: fingerprint, evidenceReferences: ["artifact:diff-integration"], verdict: "changes-required",
      findings: [{ id: "finding", classification: "blocker", evidenceReference: "artifact:diff-integration", summary: "Correction required." }], residualUncertainty: "blocked",
    },
  };
  const remediation = applyPhaseTransition(running, { ...audit, to: "remediation" });
  const correction = applyPhaseTransition(remediation, { ...audit, to: "hand-running" });
  assert.equal(correction.primaryInspection, undefined);
  assert.equal(correction.scaleReview, undefined);
  assert.equal(correction.scaleWaiver, undefined);
  assert.equal(correction.remediation?.sourceReviewId, "scale-review-blocked");
});

function runtimeController() {
  const root = mkdtempSync(join(tmpdir(), "godmode-phase3-runtime-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "feature.ts"), "export const feature = true;\\n");
  writeFileSync(join(root, "phase4-evidence.txt"), "documentation evidence passed\\n");
  const manager = SessionManager.create(root, join(root, "sessions"));
  let record: WorkflowRecord | undefined;
  let latestScaleRun: { runId: string; admissionId?: string; faculty: "scale"; state: "complete" | "failed" } | undefined;
  let captureNumber = 0;
  const instance = createPrimaryWorkflowController({
    pi: { appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); } },
    getSessionManager: () => manager,
    getWorkflowRecord: () => record,
    setWorkflowRecord: (next) => { record = next; },
    cwd: () => root,
    now: () => "2026-09-04T03:00:00.000Z",
    captureInspectionArtifacts: () => {
      captureNumber += 1;
      const suffix = captureNumber <= 2 ? "phase3" : "fresh";
      const createdAt = "2026-09-04T03:00:00.000Z";
      const expiresAt = "2099-01-01T00:00:00.000Z";
      const status = Buffer.from(`status-${suffix}`);
      const completeDiff = Buffer.from(`diff-${suffix}`);
      const ref = (kind: "git-status" | "git-complete-diff", id: string, bytes: Buffer) => ({
        id, kind, source: `/tmp/godmode-phase3-${suffix}-${kind}.bin`,
        sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, createdAt, expiresAt,
      });
      return {
        status, completeDiff, fingerprint: captureNumber <= 2 ? fingerprint : "b".repeat(64), changedPaths: ["src/feature.ts"],
        statusReference: ref("git-status", `artifact:status-${suffix}`, status),
        completeDiffReference: ref("git-complete-diff", `artifact:diff-${suffix}`, completeDiff),
        artifactDirectory: `/tmp/pi-godmode-inspection-test-${captureNumber}`,
      };
    },
    verifyInspectionArtifacts: () => true,
    getLatestScaleRun: () => latestScaleRun,
  });
  return {
    root,
    instance,
    getRecord: () => record,
    setRecord: (next: WorkflowRecord) => { record = next; },
    addUserMessage: (content: string) => { manager.appendMessage({ role: "user", content, timestamp: Date.now() }); },
    setLatestScaleRun: (runId: string, state: "complete" | "failed" = "complete") => {
      const admissionId = record?.scaleAdmission?.admissionId ?? "scale-admission-" + "a".repeat(64);
      if (record?.phase === "scale-running" && record.primaryInspection) {
        record = {
          ...record,
          scaleAdmission: {
            admissionId, nonce: "a".repeat(64), workItemId: record.workItemId,
            inspectionId: record.primaryInspection.id, diffFingerprint: record.primaryInspection.diffFingerprint,
            admittedAt: "2026-09-04T03:00:00.000Z", boundRunId: runId,
          },
        };
      }
      latestScaleRun = { runId, admissionId, faculty: "scale", state };
    },
  };
}

function specifyDocumentation(instance: ReturnType<typeof createPrimaryWorkflowController>): void {
  instance.execute({
    action: "specify",
    workItemId: "phase3-controller-1",
    classification: "documentation/configuration",
    goal: "A user can observe the documented feature behavior through the supported interface under bounded workflow controls.",
    requirementIds: ["FR-1"],
    functionalRequirements: [{ id: "FR-1", description: "The documented behavior is observable through the supported interface.", interface: "library interface" }],
    nonGoals: ["No unrelated source or release changes."],
    expectedPaths: ["src/feature.ts"],
    roadmap: [{ id: "item-1", requirementIds: ["FR-1"], title: "Document the behavior" }],
    acceptanceChecks: ["npm test", "npm run typecheck"],
    authorityConstraints: ["Hand may change only the bounded correction paths."],
  });
  instance.execute({
    action: "waive-tdd",
    requirementIds: ["FR-1"],
    inapplicableSeam: "No executable seam applies to documentation-only behavior.",
    reason: "Documentation only; no executable behavior changes.",
    scope: ["src/feature.ts"],
    compensatingCheck: "npm test",
  });
}

function advance(record: WorkflowRecord, phases: readonly WorkflowRecord["phase"][]): WorkflowRecord {
  return phases.reduce((current, to) => applyPhaseTransition(current, { ...audit, to }), record);
}

/** Phase 3 controller fixtures now exercise the compact complete Phase 4
 * matrix after every fresh inspection without executing any interface. */
function recordCompactMatrix(runtime: ReturnType<typeof runtimeController>): void {
  const surfaces = ["browser-ui", "tui", "api", "cli", "library", "persistence-migration", "build-config", "documentation"] as const;
  const methods = {
    "browser-ui": "real-browser-flow", tui: "deterministic-pty", api: "controlled-request", cli: "executable-invocation",
    library: "downstream-consumer", "persistence-migration": "disposable-storage", "build-config": "supported-build-config-check", documentation: "rendered-doc-validation",
  } as const;
  runtime.instance.execute({
    action: "record-evidence-matrix",
    acceptanceCheckSpecs: [{ id: "check-documentation", surface: "documentation", method: methods.documentation, requirementIds: ["FR-1"], interaction: "Validate the rendered documentation contract." }],
    applicabilityDecisions: surfaces.map((surface) => ({ surface, requirementIds: ["FR-1"], applicability: surface === "documentation" ? "applicable" : "not-applicable", reason: surface === "documentation" ? "The documentation surface is the changed contract." : `The ${surface} surface is not changed by this documentation item.` })),
    interfaceEvidence: [{ acceptanceCheckId: "check-documentation", surface: "documentation", method: methods.documentation, requirementIds: ["FR-1"], scenario: "Render the documented page.", invocation: "supported markdown renderer", environment: "Disposable local documentation fixture.", observedResult: "The rendered documentation contract passed.", result: "passed", artifactInputPaths: ["phase4-evidence.txt"] }],
  });
}

test("Scale admission persists before spawn, includes every inspected path, and never auto-accepts", async () => {
  let record = applyPhaseTransition(withInspection(toPrimaryVerifying()), { ...audit, to: "evidence-ready" });
  let completion: ((payload: unknown) => void) | undefined;
  let spawnAssignment = "";
  let runNumber = 0;
  const client = {
    onCompletion(handler: (payload: unknown) => void) { completion = handler; return () => { completion = undefined; }; },
    onControl(_handler: (payload: unknown) => void) { return () => {}; },
    async ping() {},
    async spawn(params: { task: string }) {
      assert.equal(record.phase, "scale-running", "Scale must be persisted before child spawn");
      spawnAssignment = params.task;
      runNumber += 1;
      return { runId: `scale-integration-run-${runNumber}`, state: "running" as const };
    },
    async status() { return { runId: `scale-integration-run-${runNumber}`, state: "running" as const }; },
    async steer() {},
    async stop() {},
  };
  let model = { provider: "old", id: "model" };
  let thinking: ThinkingLevel = "high";
  const mode = new GodmodeMode({
    client: client as never,
    modelLease: new ModelLease(),
    modelHost: {
      findModel: (provider, id) => ({ provider, id }),
      isModelScoped: () => true,
      setModel: async (next) => { model = next; return true; },
      getModel: () => model,
      getThinkingLevel: () => thinking,
      setThinkingLevel: (level) => { thinking = level; },
    },
    loadConfig: async () => validConfig(),
    isTrusted: () => true,
    cwd: () => "/tmp",
    sessionId: () => "phase3-scale-session",
    getWorkflowRecord: () => record,
    persistWorkflowTransition: (to, reason, reference) => {
      record = applyPhaseTransition(record, { ...audit, to, reason, reference });
      return record;
    },
    createScaleAdmission: (current) => {
      const nonce = "b".repeat(64);
      return {
        admissionId: `scale-admission-${nonce}`, nonce, workItemId: current.workItemId,
        inspectionId: current.primaryInspection!.id, diffFingerprint: current.primaryInspection!.diffFingerprint,
        admittedAt: audit.timestamp,
      };
    },
    persistScaleAdmission: (admission) => {
      record = { ...applyPhaseTransition(record, { ...audit, to: "scale-running" }), scaleAdmission: admission };
      return record;
    },
    bindScaleAdmission: (admissionId, runId) => {
      record = { ...record, scaleAdmission: { ...record.scaleAdmission!, admissionId, boundRunId: runId } };
      return record;
    },
    verifyInspectionArtifacts: () => true,
    validateFacultyModels: () => {},
    registerFaculties: () => [],
    registerCeiling: () => ({ dispose() {} }),
    preflight: async () => {},
    acquireTools: () => {},
    releaseTools: () => {},
  });
  await mode.enable();
  await mode.delegate({ faculty: "scale", title: "Review", task: "Review the current implementation" });
  assert.match(spawnAssignment, /src\/workflow-state\.ts/);
  assert.match(spawnAssignment, /notes\.tmp/);
  completion?.({ runId: "scale-integration-run-1", success: true, results: [{ success: true }] });
  assert.equal(mode.snapshot.lastRun?.state, "complete");
  assert.equal(record.phase, "scale-running", "Scale completion is evidence for review, not acceptance");
  assert.notEqual(record.phase, "accepted");
  // A failed/stopped Scale run is lifecycle evidence of a blocked gate, never
  // a reviewable result. Re-enter the gate only through the canonical graph.
  record = applyPhaseTransition(record, { ...audit, to: "blocked", reason: "Re-run after the completed review was not yet recorded." });
  record = applyPhaseTransition(record, { ...audit, to: "primary-verifying" });
  record = applyPhaseTransition(record, { ...audit, to: "evidence-ready" });
  await mode.delegate({ faculty: "scale", title: "Review retry", task: "Review the current implementation again" });
  completion?.({ runId: "scale-integration-run-2", success: false, results: [{ success: false }] });
  assert.equal(mode.snapshot.lastRun?.state, "failed");
  assert.equal(record.phase, "blocked");
  await mode.disable();
});

test("normal controller enforces exact inspection checks, bounded remediation, and a fresh re-review", () => {
  const runtime = runtimeController();
  specifyDocumentation(runtime.instance);
  let record = runtime.getRecord()!;
  record = advance(record, ["hand-running", "hand-handoff", "primary-verifying"]);
  runtime.setRecord(record);
  const inspectionBase = {
    action: "record-inspection" as const,
    materiallyChangedPaths: ["src/feature.ts"],
    outOfScopeChanges: [],
    residualRisks: [],
  };
  assert.throws(() => runtime.instance.execute({
    ...inspectionBase,
    independentChecks: [
      { id: "check-test", command: "npm test", result: "passed", evidenceReference: "artifact:test-phase3" },
      { id: "check-typecheck", command: "npm run typecheck", result: "failed", evidenceReference: "artifact:typecheck-phase3" },
    ],
  }), /every|pass|exact/i);
  const inspected = runtime.instance.execute({
    ...inspectionBase,
    independentChecks: [
      { id: "check-test", command: "npm test", result: "passed", evidenceReference: "artifact:test-phase3" },
      { id: "check-typecheck", command: "npm run typecheck", result: "passed", evidenceReference: "artifact:typecheck-phase3" },
    ],
  });
  assert.equal(inspected.phase, "evidence-ready");
  recordCompactMatrix(runtime);
  record = runtime.getRecord()!;
  record = applyPhaseTransition(record, { ...audit, to: "scale-running" });
  runtime.setRecord(record);
  runtime.setLatestScaleRun("scale-phase3-failed", "failed");
  assert.throws(() => runtime.instance.execute({
    action: "record-scale-review",
    evidenceReferences: ["artifact:diff-phase3", "artifact:finding-phase3"],
    verdict: "changes-required",
    findings: [{ id: "finding-failed-run", classification: "fix-now", evidenceReference: "artifact:finding-phase3", summary: "The failed Scale run cannot authorize correction." }],
    residualUncertainty: "No review may be recorded from a failed run.",
    correctionScope: ["src/feature.ts"],
  }), /latest completed|complete|Scale/i);
  runtime.setLatestScaleRun("scale-phase3-1");
  const changes = runtime.instance.execute({
    action: "record-scale-review",
    evidenceReferences: ["artifact:diff-phase3", "artifact:finding-phase3"],
    verdict: "changes-required",
    findings: [{ id: "finding-phase3", classification: "fix-now", evidenceReference: "artifact:finding-phase3", summary: "The bounded source correction is required." }],
    residualUncertainty: "The correction must be re-inspected.",
    correctionScope: ["src/feature.ts"],
  });
  assert.equal(changes.phase, "remediation");
  assert.deepEqual(runtime.getRecord()?.remediation?.correctionScope, ["src/feature.ts"]);
  assert.doesNotThrow(() => validateDelegation({
    faculty: "hand", title: "Correct", task: "Apply the bounded correction", expectedPaths: ["src/feature.ts"],
    acceptanceChecks: ["npm test", "npm run typecheck"],
  }, runtime.root, runtime.getRecord()));
  assert.throws(() => validateDelegation({
    faculty: "hand", title: "Correct", task: "Apply the bounded correction", expectedPaths: ["src/feature.ts", "README.md"],
    acceptanceChecks: ["npm test", "npm run typecheck"],
  }, runtime.root, runtime.getRecord()), /scope|expand/i);
  record = applyPhaseTransition(runtime.getRecord()!, { ...audit, to: "hand-running" });
  assert.equal(record.primaryInspection, undefined);
  assert.equal(record.scaleReview, undefined);
  runtime.setRecord(record);
  record = advance(record, ["hand-handoff", "primary-verifying"]);
  runtime.setRecord(record);
  const fresh = runtime.instance.execute({
    ...inspectionBase,
    settleRoadmapItemIds: ["item-1"],
    independentChecks: [
      { id: "check-test-fresh", command: "npm test", result: "passed", evidenceReference: "artifact:test-fresh" },
      { id: "check-typecheck-fresh", command: "npm run typecheck", result: "passed", evidenceReference: "artifact:typecheck-fresh" },
    ],
  });
  assert.equal(fresh.phase, "evidence-ready");
  recordCompactMatrix(runtime);
  record = applyPhaseTransition(runtime.getRecord()!, { ...audit, to: "scale-running" });
  runtime.setRecord(record);
  runtime.setLatestScaleRun("scale-phase3-2");
  const passed = runtime.instance.execute({
    action: "record-scale-review",
    evidenceReferences: ["artifact:status-fresh", "artifact:diff-fresh", "artifact:test-fresh", "artifact:typecheck-fresh", ...runtime.getRecord()!.interfaceEvidence!.flatMap((evidence) => evidence.artifactReferences)],
    verdict: "pass", findings: [], residualUncertainty: "No residual uncertainty beyond the recorded packet risks.",
  });
  assert.equal(passed.phase, "review-passed");
  assert.equal(runtime.getRecord()?.remediation?.active, false);
  assert.equal(runtime.instance.execute({ action: "accept", reason: "Primary accepted after fresh inspection and Scale pass." }).phase, "accepted");
});

function prepareScale(runtime: ReturnType<typeof runtimeController>): void {
  specifyDocumentation(runtime.instance);
  let record = advance(runtime.getRecord()!, ["hand-running", "hand-handoff", "primary-verifying"]);
  runtime.setRecord(record);
  runtime.instance.execute({
    action: "record-inspection",
    materiallyChangedPaths: ["src/feature.ts"],
    outOfScopeChanges: [],
    independentChecks: [
      { id: "check-waiver-test", command: "npm test", result: "passed", evidenceReference: "artifact:test-waiver" },
      { id: "check-waiver-typecheck", command: "npm run typecheck", result: "passed", evidenceReference: "artifact:typecheck-waiver" },
    ],
    residualRisks: [],
  });
  recordCompactMatrix(runtime);
}

test("normal controller accepts only valid user-explicit or policy Scale waivers", () => {
  const user = runtimeController();
  prepareScale(user);
  user.addUserMessage("WAIVE SCALE: phase3-controller-1");
  assert.throws(() => user.instance.execute({
    action: "waive-scale", basis: "user-explicit", scope: "named review gate", reason: "The user explicitly approved this narrow exception.",
    riskLimit: "Only the named review gate.", compensatingEvidence: "artifact:user-compensation", approvalReference: "synthetic-proof",
  }), /authority|approval|provenance/i);
  assert.equal(user.instance.execute({
    action: "waive-scale", basis: "user-explicit", scope: "named review gate", reason: "The user explicitly approved this narrow exception.",
    riskLimit: "Only the named review gate.", compensatingEvidence: "artifact:user-compensation",
  }).phase, "scale-waived");

  const policy = runtimeController();
  prepareScale(policy);
  writeFileSync(join(policy.root, "scale-policy.json"), JSON.stringify({
    workItemId: "phase3-controller-1", scope: "named policy gate", reason: "A narrow policy exception with independent compensation.",
    riskLimit: "Only the named policy gate.", owner: "Primary", compensatingEvidence: "artifact:policy-compensation",
    expiresAt: "2099-01-01T00:00:00.000Z", reviewAt: "2098-01-01T00:00:00.000Z",
  }));
  assert.throws(() => policy.instance.execute({
    action: "waive-scale", basis: "policy", scope: "named policy gate", reason: "A narrow policy exception with independent compensation.",
    riskLimit: "Only the named policy gate.", compensatingEvidence: "artifact:policy-compensation",
  }), /policy|owner|expiry|reference|waiver/i);
  assert.equal(policy.instance.execute({
    action: "waive-scale", basis: "policy", policyPath: "scale-policy.json",
  }).phase, "scale-waived");
});

test("normal controller enforces the three-attempt remediation cap", () => {
  const runtime = runtimeController();
  prepareScale(runtime);
  let scaleRunning = applyPhaseTransition(runtime.getRecord()!, { ...audit, to: "scale-running" });
  runtime.setRecord(scaleRunning);
  const capped = {
    ...runtime.getRecord()!,
    remediation: {
      id: "remediation-capped", sourceReviewId: "scale-review-old", sourceFindingIds: ["finding-old"],
      correctionScope: ["src/feature.ts"], attempt: 3, maxAttempts: 3, active: true, createdAt: audit.timestamp,
    },
  } as WorkflowRecord;
  assert.equal(validateWorkflowRecord(capped).ok, true);
  runtime.setRecord(capped);
  runtime.setLatestScaleRun("scale-cap-run");
  assert.throws(() => runtime.instance.execute({
    action: "record-scale-review", evidenceReferences: ["artifact:diff-waiver", "artifact:finding-cap"], verdict: "changes-required",
    findings: [{ id: "finding-cap", classification: "fix-now", evidenceReference: "artifact:finding-cap", summary: "A further correction is not permitted." }],
    residualUncertainty: "The bounded remediation cap has been reached.", correctionScope: ["src/feature.ts"],
  }), /capped|attempt/i);
  const inspection = runtime.getRecord()!.primaryInspection!;
  assert.equal(runtime.instance.execute({
    action: "record-scale-review",
    evidenceReferences: [
      inspection.statusReference,
      inspection.completeDiffReference,
      ...inspection.independentChecks.map((check) => check.evidenceReference),
      ...runtime.getRecord()!.interfaceEvidence!.flatMap((evidence) => evidence.artifactReferences),
    ],
    verdict: "pass", findings: [], residualUncertainty: "The third correction resolved every blocking finding.",
  }).phase, "review-passed", "the remediation cap must not reject a passing final review");
});
