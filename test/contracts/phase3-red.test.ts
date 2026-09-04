import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPhaseTransition, applyRoadmapTransition, validateWorkflowRecord } from "../../src/workflow-state.ts";
import type { WorkflowRecord } from "../../src/types.ts";
import { workflowRecord } from "../fixtures/workflow.ts";

const audit = {
  actor: "Primary" as const,
  timestamp: "2026-09-04T02:00:00.000Z",
  reason: "Controlled Phase 3 contract fixture.",
  reference: "evidence:phase3-contract",
};
const fingerprint = "a".repeat(64);

function advance(record: WorkflowRecord, phases: readonly Parameters<typeof applyPhaseTransition>[1]["to"][]): WorkflowRecord {
  return phases.reduce((current, to) => applyPhaseTransition(current, { ...audit, to }), record);
}

function settledReviewPassed(): WorkflowRecord {
  let record = advance(workflowRecord(), [
    "classified", "specified", "red-test-ready", "red-test-observed", "hand-running", "hand-handoff", "primary-verifying",
  ]);
  Object.assign(record, {
    primaryInspection: {
      id: "inspection-1",
      actor: "Primary",
      inspectedAt: audit.timestamp,
      statusReference: "artifact:status-1",
      completeDiffReference: "artifact:diff-1",
      diffFingerprint: fingerprint,
      materiallyChangedPaths: ["src/workflow-state.ts", "test/contracts/phase3-red.test.ts"],
      outOfScopeChanges: [{ path: "notes.tmp", disposition: "investigated-generated-artifact" }],
      independentChecks: [{ id: "check-1", command: "npm test", result: "passed", evidenceReference: "artifact:test-1" }],
      residualRisks: ["Interface-evidence automation remains Phase 4 scope."],
    },
  });
  record = applyPhaseTransition(record, { ...audit, to: "evidence-ready" });
  record = applyPhaseTransition(record, { ...audit, to: "scale-running" });
  Object.assign(record, {
    scaleAdmission: {
      admissionId: `scale-admission-${"c".repeat(64)}`,
      nonce: "c".repeat(64),
      workItemId: record.workItemId,
      inspectionId: "inspection-1",
      diffFingerprint: fingerprint,
      admittedAt: audit.timestamp,
      boundRunId: "fresh-scale-run-1",
    },
    scaleReview: {
      id: "scale-review-1",
      runId: "fresh-scale-run-1",
      admissionId: `scale-admission-${"c".repeat(64)}`,
      reviewer: "Scale",
      completedAt: audit.timestamp,
      freshContext: true,
      diffFingerprint: fingerprint,
      evidenceReferences: ["artifact:status-1", "artifact:diff-1", "artifact:test-1"],
      verdict: "pass",
      findings: [],
      residualUncertainty: "None beyond recorded residual risks.",
    },
  });
  record = applyPhaseTransition(record, { ...audit, to: "review-passed" });
  for (const item of record.roadmap) {
    record = applyRoadmapTransition(record, item.id, { ...audit, actor: "Hand", to: "implemented-unverified" });
    record = applyRoadmapTransition(record, item.id, { ...audit, to: "verified" });
  }
  return record;
}

test("FR-5/FR-6 acceptance rejects settled work without Primary inspection and current Scale review", () => {
  let record = advance(workflowRecord(), [
    "classified", "specified", "red-test-ready", "red-test-observed", "hand-running", "hand-handoff", "primary-verifying",
  ]);
  Object.assign(record, {
    primaryInspection: {
      id: "inspection-acceptance", actor: "Primary", inspectedAt: audit.timestamp,
      statusReference: "artifact:status-acceptance", completeDiffReference: "artifact:diff-acceptance", diffFingerprint: fingerprint,
      materiallyChangedPaths: ["src/workflow-state.ts"], outOfScopeChanges: [],
      independentChecks: [{ id: "check-acceptance", command: "npm test", result: "passed", evidenceReference: "artifact:test-acceptance" }], residualRisks: [],
    },
  });
  record = applyPhaseTransition(record, { ...audit, to: "evidence-ready" });
  record = applyPhaseTransition(record, { ...audit, to: "scale-running" });
  Object.assign(record, {
    scaleAdmission: {
      admissionId: `scale-admission-${"d".repeat(64)}`, nonce: "d".repeat(64), workItemId: record.workItemId,
      inspectionId: "inspection-acceptance", diffFingerprint: fingerprint, admittedAt: audit.timestamp, boundRunId: "fresh-scale-acceptance",
    },
    scaleReview: {
      id: "scale-review-acceptance", runId: "fresh-scale-acceptance", admissionId: `scale-admission-${"d".repeat(64)}`, reviewer: "Scale", completedAt: audit.timestamp,
      freshContext: true, diffFingerprint: fingerprint,
      evidenceReferences: ["artifact:status-acceptance", "artifact:diff-acceptance", "artifact:test-acceptance"],
      verdict: "pass", findings: [], residualUncertainty: "none",
    },
  });
  record = applyPhaseTransition(record, { ...audit, to: "review-passed" });
  for (const item of record.roadmap) {
    record = applyRoadmapTransition(record, item.id, { ...audit, actor: "Hand", to: "implemented-unverified" });
    record = applyRoadmapTransition(record, item.id, { ...audit, to: "verified" });
  }
  delete (record as WorkflowRecord & { primaryInspection?: unknown }).primaryInspection;
  delete (record as WorkflowRecord & { scaleReview?: unknown }).scaleReview;
  assert.throws(() => applyPhaseTransition(record, { ...audit, to: "accepted" }), /inspection|independent|Scale|review|evidence/i);
});

test("FR-6 scale-waived rejects capacity/convenience metadata and requires bounded compensation", () => {
  let record = advance(workflowRecord(), [
    "classified", "specified", "red-test-ready", "red-test-observed", "hand-running", "hand-handoff", "primary-verifying",
  ]);
  Object.assign(record, {
    primaryInspection: {
      id: "inspection-1", actor: "Primary", inspectedAt: audit.timestamp,
      statusReference: "artifact:status-1", completeDiffReference: "artifact:diff-1", diffFingerprint: fingerprint,
      materiallyChangedPaths: ["src/workflow-state.ts"], outOfScopeChanges: [],
      independentChecks: [{ id: "check-1", command: "npm test", result: "passed", evidenceReference: "artifact:test-1" }],
      residualRisks: [],
    },
  });
  record = applyPhaseTransition(record, { ...audit, to: "evidence-ready" });
  Object.assign(record, {
    scaleWaiver: {
      id: "scale-waiver-1", item: record.workItemId, basis: "policy", actor: "Primary", approver: "Primary",
      date: audit.timestamp, scope: "all changes", reason: "Scale has no capacity and this is convenient.",
      riskLimit: "Any risk", compensatingEvidence: "none",
    },
  });
  assert.throws(() => applyPhaseTransition(record, { ...audit, to: "scale-waived" }), /waiver|scope|capacity|convenience|compensating|risk/i);
});

test("FR-6 rejects summary-only or stale Scale review evidence", () => {
  let record = settledReviewPassed();
  const hostile = structuredClone(record) as WorkflowRecord & { scaleReview?: Record<string, unknown> };
  assert(hostile.scaleReview);
  hostile.scaleReview.diffFingerprint = "b".repeat(64);
  const validation = validateWorkflowRecord(hostile);
  assert.equal(validation.ok, false, "a review of a different diff fingerprint was accepted");
});

test("FR-7 remediation invalidates prior inspection and review and forces fresh re-review", () => {
  let record = settledReviewPassed();
  record = applyPhaseTransition(record, { ...audit, to: "rejected" });
  // A terminal rejection cannot be reused for remediation; start from a changes-required Scale handoff instead.
  record = settledReviewPassed();
  record.phase = "scale-running";
  // Keep the canonical phase ancestry coherent while converting the fixture
  // into an exact completed Scale handoff with a changes-required verdict.
  record.history = record.history.filter((entry) => !(entry.kind === "phase" && entry.to === "review-passed"));
  Object.assign(record, {
    scaleReview: {
      id: "scale-review-blocked", runId: "fresh-scale-run-1", admissionId: `scale-admission-${"c".repeat(64)}`, reviewer: "Scale", completedAt: audit.timestamp,
      freshContext: true, diffFingerprint: fingerprint, evidenceReferences: ["artifact:diff-1", "src/workflow-state.ts:1"], verdict: "changes-required",
      findings: [{ id: "finding-1", classification: "fix-now", evidenceReference: "src/workflow-state.ts:1", summary: "Gate bypass." }],
      residualUncertainty: "Correction required.",
    },
  });
  record = applyPhaseTransition(record, { ...audit, to: "remediation", reference: "finding:finding-1" });
  const correction = applyPhaseTransition(record, { ...audit, to: "hand-running", reference: "remediation:attempt-1" });
  const corrected = correction as WorkflowRecord & { primaryInspection?: unknown; scaleReview?: unknown };
  assert.equal(corrected.primaryInspection, undefined, "correction retained stale Primary inspection");
  assert.equal(corrected.scaleReview, undefined, "correction retained stale Scale review");
});

test("FR-5/FR-6 acceptance remains Primary-only even with complete gate records", () => {
  const record = settledReviewPassed();
  for (const actor of ["Eye", "Hand", "Scale"] as const) {
    assert.throws(() => applyPhaseTransition(record, { ...audit, actor, to: "accepted" }), /Primary|authority/i);
  }
});
