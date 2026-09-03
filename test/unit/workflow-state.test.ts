import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPhaseTransition,
  applyRoadmapTransition,
  deriveChecklistView,
  validateWorkflowRecord,
} from "../../src/workflow-state.ts";
import { workflowRecord } from "../fixtures/workflow.ts";

const audit = {
  actor: "Primary" as const,
  timestamp: "2026-09-03T00:00:00.000Z",
  reason: "Observed controlled evidence.",
  reference: "evidence:test-1",
};

test("workflow phase transitions follow the normative graph and preserve the input", () => {
  const original = workflowRecord();
  const classified = applyPhaseTransition(original, { ...audit, to: "classified" });
  assert.equal(classified.phase, "classified");
  assert.equal(original.phase, "draft");
  assert.equal(classified.history.length, 1);
  assert.deepEqual(classified.history[0], {
    kind: "phase",
    workItemId: "work-1",
    from: "draft",
    to: "classified",
    ...audit,
  });
  assert.throws(
    () => applyPhaseTransition(original, { ...audit, to: "hand-running" }),
    /draft.*hand-running|transition/i,
  );
});

function advanceToReview(record = workflowRecord()) {
  return ([
    "classified",
    "specified",
    "red-test-ready",
    "red-test-observed",
    "hand-running",
    "hand-handoff",
    "primary-verifying",
    "evidence-ready",
    "scale-running",
    "review-passed",
  ] as const).reduce((current, to) => applyPhaseTransition(current, { ...audit, to }), record);
}

test("blocking and recovery are bounded by the normative phase graph", () => {
  const verifying = ([
    "classified", "specified", "red-test-ready", "red-test-observed",
    "hand-running", "hand-handoff", "primary-verifying",
  ] as const).reduce((current, to) => applyPhaseTransition(current, { ...audit, to }), workflowRecord());
  const blocked = applyPhaseTransition(verifying, { ...audit, to: "blocked" });
  assert.equal(blocked.phase, "blocked");
  assert.equal(
    applyPhaseTransition(blocked, { ...audit, to: "primary-verifying" }).phase,
    "primary-verifying",
  );
  assert.throws(() => applyPhaseTransition(blocked, { ...audit, to: "accepted" }), /transition/i);
});

test("only Primary can verify, waive, or accept and acceptance requires settled roadmap items", () => {
  const scoped = workflowRecord({
    roadmap: [{ id: "item-1", requirementIds: ["FR-2"], title: "State", status: "pending" }],
  });
  const implemented = advanceToReview(applyRoadmapTransition(scoped, "item-1", {
    ...audit,
    actor: "Hand",
    to: "implemented-unverified",
  }));
  assert.throws(
    () => applyRoadmapTransition(implemented, "item-1", { ...audit, actor: "Hand", to: "verified" }),
    /Primary/i,
  );
  assert.throws(() => applyPhaseTransition(implemented, { ...audit, to: "accepted" }), /roadmap|verified|waived/i);

  const verified = applyRoadmapTransition(implemented, "item-1", { ...audit, to: "verified" });
  assert.equal(applyPhaseTransition(verified, { ...audit, to: "accepted" }).phase, "accepted");
});

test("waivers require Primary authority, a reason, and a decision reference", () => {
  const record = workflowRecord();
  assert.throws(
    () => applyRoadmapTransition(record, "item-1", { ...audit, reason: "", to: "waived" }),
    /reason/i,
  );
  assert.throws(
    () => applyRoadmapTransition(record, "item-1", { ...audit, reference: "", to: "waived" }),
    /reference/i,
  );
  assert.equal(applyRoadmapTransition(record, "item-1", { ...audit, to: "waived" }).roadmap[0]?.status, "waived");
});

test("raw authority-bearing state requires a matching Primary audit", () => {
  const unauditedAccepted = workflowRecord({
    phase: "accepted",
    roadmap: [{ id: "item-1", requirementIds: ["FR-2"], title: "State", status: "verified" }],
  });
  assert.equal(validateWorkflowRecord(unauditedAccepted).ok, false);

  const unauditedVerified = workflowRecord({
    roadmap: [{ id: "item-1", requirementIds: ["FR-2"], title: "State", status: "verified" }],
  });
  assert.equal(validateWorkflowRecord(unauditedVerified).ok, false);

  for (const waivedPhase of ["tdd-waived", "scale-waived"] as const) {
    const hostile = workflowRecord({
      phase: "blocked",
      history: [
        {
          kind: "phase",
          workItemId: "work-1",
          from: waivedPhase === "tdd-waived" ? "red-test-ready" : "evidence-ready",
          to: waivedPhase,
          actor: "Hand",
          timestamp: audit.timestamp,
          reason: audit.reason,
          reference: audit.reference,
        },
        {
          kind: "phase",
          workItemId: "work-1",
          from: waivedPhase,
          to: "blocked",
          actor: "Primary",
          timestamp: audit.timestamp,
          reason: "Later unresolved evidence.",
          reference: "decision:block-1",
        },
      ],
    });
    assert.equal(validateWorkflowRecord(hostile).ok, false);
  }
});

test("derived checklists are immutable projections and unknown or conflicting state fails closed", () => {
  const record = workflowRecord();
  const view = deriveChecklistView(record);
  assert.deepEqual(view.items, [
    { id: "item-1", title: "Canonical transitions", status: "pending", requirementIds: ["FR-2"] },
    { id: "item-2", title: "Branch recovery", status: "pending", requirementIds: ["FR-9"] },
  ]);
  assert(Object.isFrozen(view));
  assert(Object.isFrozen(view.items));

  const duplicate = workflowRecord({ roadmap: [record.roadmap[0]!, record.roadmap[0]!] });
  const invalid = validateWorkflowRecord(duplicate);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.blocked.phase, "blocked");

  const unknown = workflowRecord({ phase: "mystery" as never });
  assert.equal(validateWorkflowRecord(unknown).ok, false);
});
