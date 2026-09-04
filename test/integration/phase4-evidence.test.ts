import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "node:test";
import { createPrimaryWorkflowController } from "../../src/tools.ts";
import { renderAssignment, validateDelegation } from "../../src/faculties.ts";
import { reconstructActiveSnapshot } from "../../src/session-ledger.ts";
import { applyPhaseTransition, validateInterfaceEvidenceMatrix, validateInterfaceEvidenceMatrixDetailed, validateWorkflowRecord } from "../../src/workflow-state.ts";
import type { BoundedEvidenceReference, WorkflowRecord } from "../../src/types.ts";

const surfaces = ["browser-ui", "tui", "api", "cli", "library", "persistence-migration", "build-config", "documentation"] as const;
const methods = {
  "browser-ui": "real-browser-flow",
  tui: "deterministic-pty",
  api: "controlled-request",
  cli: "executable-invocation",
  library: "downstream-consumer",
  "persistence-migration": "disposable-storage",
  "build-config": "supported-build-config-check",
  documentation: "rendered-doc-validation",
} as const;
const audit = {
  actor: "Primary" as const,
  timestamp: "2026-09-04T04:00:00.000Z",
  reason: "Phase 4 integration fixture.",
  reference: "phase4-integration",
};

function runtimeController() {
  const root = mkdtempSync(join(tmpdir(), "godmode-phase4-runtime-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "feature.ts"), "export const feature = true;\n");
  writeFileSync(join(root, "test", "red.test.ts"), "import assert from 'node:assert/strict';\nassert.equal(false, true);\n");
  for (const [index, surface] of surfaces.entries()) {
    writeFileSync(join(root, `evidence-${index}-${surface}.txt`), `surface=${surface}\nresult=passed\nunique=${index}\n`);
    writeFileSync(join(root, `retry-${index}-${surface}.txt`), `surface=${surface}\nresult=passed\nretry=${index}\n`);
  }
  const manager = SessionManager.create(root, join(root, "sessions"));
  let record: WorkflowRecord | undefined;
  let latestScaleRun: { runId: string; admissionId?: string; faculty: "scale"; state: "complete" | "failed" } | undefined;
  let captureCount = 0;
  const controller = createPrimaryWorkflowController({
    pi: { appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); } },
    getSessionManager: () => manager,
    getWorkflowRecord: () => record,
    setWorkflowRecord: (next) => { record = next; },
    cwd: () => root,
    now: () => audit.timestamp,
    captureInspectionArtifacts: () => {
      captureCount += 1;
      const directory = mkdtempSync(join(tmpdir(), "godmode-phase4-inspection-"));
      const status = Buffer.from(`status-${captureCount}`);
      const completeDiff = Buffer.from(`diff-${captureCount}`);
      const statusPath = join(directory, "status.txt");
      const diffPath = join(directory, "diff.txt");
      writeFileSync(statusPath, status);
      writeFileSync(diffPath, completeDiff);
      const ref = (kind: "git-status" | "git-complete-diff", id: string, source: string, bytes: Buffer) => ({
        id, kind, source, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength,
        createdAt: audit.timestamp, expiresAt: "2099-01-01T00:00:00.000Z",
      });
      return {
        status,
        completeDiff,
        fingerprint: createHash("sha256").update(completeDiff).digest("hex"),
        changedPaths: ["src/feature.ts"],
        statusReference: ref("git-status", `artifact:status-${captureCount}`, statusPath, status),
        completeDiffReference: ref("git-complete-diff", `artifact:diff-${captureCount}`, diffPath, completeDiff),
        artifactDirectory: directory,
      };
    },
    verifyInspectionArtifacts: () => true,
    getLatestScaleRun: () => latestScaleRun,
  });
  // Keep the fixture intentionally independent of any command, browser, PTY,
  // network, or executable execution.
  return {
    root,
    manager,
    controller,
    getRecord: () => record,
    setRecord: (next: WorkflowRecord) => { record = next; },
    setLatestScaleRun: (runId: string) => { latestScaleRun = { runId, admissionId: record?.scaleAdmission?.admissionId, faculty: "scale", state: "complete" }; },
  };
}

function specify(runtime: ReturnType<typeof runtimeController>): void {
  runtime.controller.execute({
    action: "specify",
    workItemId: "phase4-integration",
    classification: "feature",
    goal: "The feature is observable through its supported interface.",
    requirementIds: ["FR-8"],
    functionalRequirements: [{ id: "FR-8", description: "The feature exposes the supported interface behavior.", interface: "all supported interfaces" }],
    nonGoals: ["No automatic interface execution or unrelated changes."],
    expectedPaths: ["src/feature.ts", "test/red.test.ts"],
    roadmap: [{ id: "item-8", requirementIds: ["FR-8"], title: "Implement the interface behavior" }],
    acceptanceChecks: ["npm test"],
    authorityConstraints: ["Only the Primary may record acceptance."],
  });
  runtime.controller.execute({
    action: "record-red",
    testPath: "test/red.test.ts",
    command: "npm test -- test/red.test.ts",
    environment: "Disposable Phase 4 fixture.",
    exitStatus: 1,
    failureKind: "missing-behavior",
    requirementIds: ["FR-8"],
    outputExcerpt: "The intended interface behavior is not implemented yet.",
    artifactReference: "artifact:red-phase4",
  });
  let record = runtime.getRecord()!;
  for (const to of ["hand-running", "hand-handoff", "primary-verifying"] as const) {
    record = applyPhaseTransition(record, { ...audit, to });
  }
  runtime.setRecord(record);
}

function inspect(runtime: ReturnType<typeof runtimeController>): void {
  runtime.controller.execute({
    action: "record-inspection",
    materiallyChangedPaths: ["src/feature.ts"],
    outOfScopeChanges: [],
    settleRoadmapItemIds: ["item-8"],
    independentChecks: [{ id: "check-phase4", command: "npm test", result: "passed", evidenceReference: "artifact:test-phase4" }],
    residualRisks: [],
  });
}

function cloneForTest<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function matrixInput(runtime: ReturnType<typeof runtimeController>, result: "passed" | "failed" | "blocked", retry = false): Record<string, unknown> {
  const prefix = retry ? "retry-" : "evidence-";
  return {
    action: "record-evidence-matrix",
    acceptanceCheckSpecs: surfaces.map((surface) => ({
      id: `check-${surface}`,
      surface,
      method: methods[surface],
      requirementIds: ["FR-8"],
      interaction: `Exercise the ${surface} contract through its supported boundary.`,
      expectedOutcome: "The controlled fixture reports the expected result.",
    })),
    applicabilityDecisions: surfaces.map((surface) => ({
      surface,
      requirementIds: ["FR-8"],
      applicability: "applicable",
      reason: `FR-8 explicitly exercises the ${surface} surface.`,
    })),
    interfaceEvidence: surfaces.map((surface, index) => ({
      acceptanceCheckId: `check-${surface}`,
      surface,
      method: methods[surface],
      requirementIds: ["FR-8"],
      scenario: `Controlled ${surface} scenario.`,
      invocation: `touch should-not-run-${surface}`,
      environment: "Disposable local fixture with no external credentials.",
      observedResult: result === "passed" ? "The controlled fixture reported the expected result." : `The ${surface} observation was ${result}.`,
      result,
      artifactInputPaths: [`${prefix}${index}-${surface}.txt`],
    })),
  };
}

test("fresh packets opt into Phase 4 for every Primary classification", () => {
  for (const classification of ["feature", "bugfix", "refactor/maintenance", "documentation/configuration", "test-only/tooling"] as const) {
    const runtime = runtimeController();
    runtime.controller.execute({
      action: "specify", workItemId: `classification-${classification}`, classification,
      goal: "A bounded Primary-authored packet records an observable requirement.", requirementIds: ["FR-1"],
      functionalRequirements: [{ id: "FR-1", description: "The packet records the observable requirement.", interface: "supported interface" }],
      nonGoals: ["No unrelated changes."], expectedPaths: ["src/feature.ts"],
      roadmap: [{ id: "item-1", requirementIds: ["FR-1"], title: "Packet behavior" }], acceptanceChecks: ["npm test"],
      authorityConstraints: ["Primary retains acceptance authority."],
    });
    assert.equal(runtime.getRecord()?.interfaceEvidencePolicy, "interface-matched-v1");
  }
});

test("Phase 4 records all surfaces, never executes invocation text, retries failed evidence, and recovers accepted snapshots", () => {
  const runtime = runtimeController();
  specify(runtime);
  inspect(runtime);
  assert.equal(runtime.getRecord()?.nextGate, "interface-evidence");
  const marker = join(runtime.root, "should-not-run-browser-ui");
  const failed = runtime.controller.execute(matrixInput(runtime, "failed"));
  assert.equal(failed.phase, "evidence-ready");
  assert.equal(existsSync(marker), false);
  assert.equal(validateInterfaceEvidenceMatrixDetailed(runtime.getRecord(), { requirePassing: false }).ok, true);
  assert.equal(validateInterfaceEvidenceMatrix(runtime.getRecord()), false);
  assert.equal(runtime.getRecord()!.applicabilityDecisions!.every((decision) => decision.actor === "Primary" && decision.inspectionId === runtime.getRecord()!.primaryInspection!.id), true);
  assert.equal(runtime.getRecord()!.interfaceEvidence!.every((evidence) => evidence.actor === "Primary" && evidence.adapter === "primary-observed-artifact" && evidence.adapterVersion === "1"), true);
  const oldEvidenceId = runtime.getRecord()!.interfaceEvidence![0]!.id;
  const oldArtifacts = runtime.getRecord()!.interfaceEvidence!.flatMap((evidence) => evidence.artifactReferences);
  const oldArtifactIds = new Set(oldArtifacts.map((reference) => typeof reference === "string" ? reference : reference.id));
  const oldSources = oldArtifacts.filter((reference): reference is BoundedEvidenceReference => typeof reference === "object" && reference !== null && typeof reference.source === "string").map((reference) => reference.source!);

  assert.throws(() => applyPhaseTransition(runtime.getRecord()!, { ...audit, to: "scale-running" }), /interface|matrix|evidence/i);
  const retried = runtime.controller.execute(matrixInput(runtime, "passed", true));
  assert.notEqual(runtime.getRecord()!.interfaceEvidence![0]!.id, oldEvidenceId);
  assert.equal(validateInterfaceEvidenceMatrix(runtime.getRecord()), true);
  assert.equal(runtime.getRecord()!.primaryInspection!.id, runtime.getRecord()!.interfaceEvidence![0]!.inspectionId);
  assert.equal(runtime.getRecord()!.interfaceEvidence!.every((evidence) => evidence.method === methods[evidence.surface]), true);
  assert.equal(runtime.getRecord()!.evidence.some((reference) => oldArtifactIds.has(reference.id)), false);
  assert.equal(oldSources.every((source) => existsSync(source)), false, "superseded artifacts are cleaned after acknowledgement");
  assert.equal(existsSync(marker), false);
  assert.equal(retried.phase, "evidence-ready");

  const malformed = cloneForTest(runtime.getRecord()!);
  malformed.applicabilityDecisions!.pop();
  assert.equal(validateWorkflowRecord(malformed).ok, false, "missing surface decision is rejected");
  const duplicateDecision = cloneForTest(runtime.getRecord()!);
  duplicateDecision.applicabilityDecisions!.push({ ...duplicateDecision.applicabilityDecisions![0]! });
  assert.equal(validateWorkflowRecord(duplicateDecision).ok, false, "duplicate surface decision is rejected");
  const mismatch = cloneForTest(runtime.getRecord()!);
  mismatch.interfaceEvidence![0]!.surface = "tui";
  assert.equal(validateWorkflowRecord(mismatch).ok, false, "surface/check mismatch is rejected");
  const substituted = cloneForTest(runtime.getRecord()!);
  substituted.acceptanceCheckSpecs![0]!.method = "unit-test";
  assert.equal(validateWorkflowRecord(substituted).ok, false, "unit-test substitution is rejected");
  const secret = cloneForTest(runtime.getRecord()!);
  secret.interfaceEvidence![0]!.observedResult = "Authorization: Bearer abcdefghijklmnop";
  assert.equal(validateWorkflowRecord(secret).ok, false, "secret-bearing observation is rejected");
  const stale = cloneForTest(runtime.getRecord()!);
  stale.interfaceEvidence![0]!.diffFingerprint = "0".repeat(64);
  assert.equal(validateWorkflowRecord(stale).ok, false, "stale evidence is rejected");
  const duplicateArtifact = cloneForTest(runtime.getRecord()!);
  duplicateArtifact.interfaceEvidence![1]!.artifactReferences = [...duplicateArtifact.interfaceEvidence![0]!.artifactReferences];
  assert.equal(validateWorkflowRecord(duplicateArtifact).ok, false, "duplicate artifact identity is rejected");

  const current = runtime.getRecord()!;
  const contextFiles = ["src/feature.ts", ...[current.primaryInspection!.statusReference, current.primaryInspection!.completeDiffReference,
    ...current.interfaceEvidence!.flatMap((evidence) => evidence.artifactReferences)]
    .flatMap((reference) => typeof reference === "string" ? [] : reference.source ? [reference.source] : [])];
  const normalized = validateDelegation({
    faculty: "scale", title: "Read-only Phase 4 review", task: "Inspect the complete current evidence matrix.",
    contextFiles, expectedPaths: [], acceptanceChecks: ["npm test"], constraints: [],
  }, runtime.root, runtime.getRecord());
  const assignment = renderAssignment(normalized, runtime.getRecord());
  assert.match(assignment, /real-browser-flow/);
  assert.match(assignment, /rendered-doc-validation/);
  assert.throws(() => validateDelegation({
    faculty: "scale", title: "Missing context", task: "Inspect evidence.", contextFiles: [], expectedPaths: [], acceptanceChecks: ["npm test"], constraints: [],
  }, runtime.root, runtime.getRecord()), /context|artifact|path/i);

  let record = applyPhaseTransition(runtime.getRecord()!, { ...audit, to: "scale-running" });
  const nonce = "f".repeat(64);
  record = { ...record, scaleAdmission: {
    admissionId: `scale-admission-${nonce}`, nonce, workItemId: record.workItemId,
    inspectionId: record.primaryInspection!.id, diffFingerprint: record.primaryInspection!.diffFingerprint,
    admittedAt: audit.timestamp, boundRunId: "phase4-run",
  } };
  runtime.setRecord(record);
  runtime.setLatestScaleRun("phase4-run");
  const inspection = record.primaryInspection!;
  const matrixArtifacts = record.interfaceEvidence!.flatMap((evidence) => evidence.artifactReferences);
  const reviewed = runtime.controller.execute({
    action: "record-scale-review",
    evidenceReferences: [inspection.statusReference, inspection.completeDiffReference, ...inspection.independentChecks.map((check) => check.evidenceReference), ...matrixArtifacts],
    verdict: "pass", findings: [], residualUncertainty: "No residual uncertainty beyond the inspected fixture.",
  });
  assert.equal(reviewed.phase, "review-passed");
  const accepted = runtime.controller.execute({ action: "accept", reason: "Primary accepted after current interface evidence and Scale review." });
  assert.equal(accepted.phase, "accepted");
  const recovered = reconstructActiveSnapshot(runtime.manager.getBranch(), runtime.manager.getSessionId(), "phase4-integration");
  assert.equal(recovered.status, "ok");
  if (recovered.status === "ok") {
    assert.equal(recovered.snapshot.record.phase, "accepted");
    assert.equal(validateWorkflowRecord(recovered.snapshot.record).ok, true);
    assert.equal(runtime.manager.getBranch().filter((entry) => entry.type === "custom").length > 1, true, "historical snapshots remain in the append-only branch");
    const acceptedSources = runtime.getRecord()!.interfaceEvidence!.flatMap((evidence) => evidence.artifactReferences)
      .filter((reference): reference is BoundedEvidenceReference => typeof reference === "object" && reference !== null && typeof reference.source === "string")
      .map((reference) => reference.source!);
    assert.equal(acceptedSources.every((source) => existsSync(source)), false, "terminal cleanup removes temporary files while snapshots remain recoverable");
  }
});
