import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPhaseTransition, validateWorkflowRecord } from "../../src/workflow-state.ts";
import type { WorkflowRecord } from "../../src/types.ts";
import { workflowRecord } from "../fixtures/workflow.ts";

const audit = {
  actor: "Primary" as const,
  timestamp: "2026-09-04T05:00:00.000Z",
  reason: "Controlled Phase 4 contract fixture.",
  reference: "evidence:phase4-contract",
};
const fingerprint = "a".repeat(64);
const surfaces = ["browser-ui", "tui", "api", "cli", "library", "persistence-migration", "build-config", "documentation"] as const;

function inspected(): WorkflowRecord {
  let record = workflowRecord({ requirementIds: ["FR-8"], roadmap: [{ id: "item-8", requirementIds: ["FR-8"], title: "Interface evidence", status: "pending" }] });
  for (const to of ["classified", "specified", "red-test-ready", "red-test-observed", "hand-running", "hand-handoff", "primary-verifying"] as const) {
    record = applyPhaseTransition(record, { ...audit, to });
  }
  return {
    ...record,
    interfaceEvidencePolicy: "interface-matched-v1",
    primaryInspection: {
      id: "inspection-phase4", actor: "Primary", inspectedAt: audit.timestamp,
      statusReference: "artifact:status-phase4", completeDiffReference: "artifact:diff-phase4", diffFingerprint: fingerprint,
      materiallyChangedPaths: ["src/evidence.ts"], outOfScopeChanges: [],
      independentChecks: [{ id: "check-phase4", command: "npm test", result: "passed", evidenceReference: "artifact:test-phase4" }], residualRisks: [],
    },
  };
}

function withCurrentMatrix(record: WorkflowRecord): WorkflowRecord {
  return {
    ...record,
    interfaceEvidencePolicy: "interface-matched-v1",
    acceptanceCheckSpecs: [{ id: "check-library", surface: "library", method: "downstream-consumer", requirementIds: ["FR-8"], interaction: "Consume the documented public package interface." }],
    applicabilityDecisions: surfaces.map((surface) => ({
      surface,
      requirementIds: ["FR-8"],
      applicability: surface === "library" ? "applicable" : "not-applicable",
      reason: surface === "library" ? "FR-8 changes the public library evidence contract." : `FR-8 does not change the ${surface} interface.`,
      actor: "Primary",
      decidedAt: audit.timestamp,
      inspectionId: "inspection-phase4",
      diffFingerprint: fingerprint,
    })),
    interfaceEvidence: [{
      id: "interface-evidence-library", workItemId: record.workItemId, requirementIds: ["FR-8"], surface: "library",
      acceptanceCheckId: "check-library", method: "downstream-consumer", scenario: "Disposable downstream consumer imports and exercises the public export.",
      invocation: "node disposable-consumer.mjs", environment: "Disposable local downstream package consumer.",
      observedResult: "Consumer completed with the expected serialized result.", artifactReferences: ["artifact:library-consumer-phase4"],
      result: "passed", actor: "Primary", capturedAt: audit.timestamp, adapter: "primary-observed-artifact", adapterVersion: "1",
      redactionStatus: "verified-clean", retentionClass: "session", expiresAt: "2099-01-01T00:00:00.000Z",
      inspectionId: "inspection-phase4", diffFingerprint: fingerprint,
    }],
  } as WorkflowRecord;
}

test("FR-8 Scale admission rejects a missing interface evidence matrix", () => {
  const ready = applyPhaseTransition(inspected(), { ...audit, to: "evidence-ready" });
  assert.throws(() => applyPhaseTransition(ready, { ...audit, to: "scale-running" }), /interface|surface|matrix|evidence/i);
});

test("FR-8 a complete current matrix permits Scale admission", () => {
  const ready = applyPhaseTransition(withCurrentMatrix(inspected()), { ...audit, to: "evidence-ready" });
  assert.equal(applyPhaseTransition(ready, { ...audit, to: "scale-running" }).phase, "scale-running");
});

test("FR-8 rejects stale inspection-bound interface evidence", () => {
  const record = withCurrentMatrix(inspected()) as WorkflowRecord & { interfaceEvidence?: Array<Record<string, unknown>> };
  record.interfaceEvidence![0]!.diffFingerprint = "b".repeat(64);
  assert.equal(validateWorkflowRecord(record).ok, false);
});

test("FR-8 rejects secret-bearing evidence instead of silently treating redaction as proof", () => {
  const record = withCurrentMatrix(inspected()) as WorkflowRecord & { interfaceEvidence?: Array<Record<string, unknown>> };
  record.interfaceEvidence![0]!.observedResult = "Authorization: Bearer secret-token-value";
  assert.equal(validateWorkflowRecord(record).ok, false);
});

test("FR-8 rejects unit-only substitution for a public interface", () => {
  const record = withCurrentMatrix(inspected()) as WorkflowRecord & { acceptanceCheckSpecs?: Array<Record<string, unknown>>; interfaceEvidence?: Array<Record<string, unknown>> };
  record.acceptanceCheckSpecs![0]!.method = "unit-test";
  record.interfaceEvidence![0]!.method = "unit-test";
  assert.equal(validateWorkflowRecord(record).ok, false);
});

test("FR-8 rejects substituted adapter provenance", () => {
  const record = withCurrentMatrix(inspected()) as WorkflowRecord & { interfaceEvidence?: Array<Record<string, unknown>> };
  record.interfaceEvidence![0]!.adapter = "controlled-library-consumer";
  assert.equal(validateWorkflowRecord(record).ok, false);
});

test("FR-8 failed or blocked applicable evidence cannot satisfy the matrix", () => {
  for (const result of ["failed", "blocked"] as const) {
    const record = withCurrentMatrix(inspected()) as WorkflowRecord & { interfaceEvidence?: Array<Record<string, unknown>> };
    record.interfaceEvidence![0]!.result = result;
    assert.throws(() => applyPhaseTransition(record, { ...audit, to: "evidence-ready" }), /failed|blocked|interface|matrix|evidence/i);
  }
});
