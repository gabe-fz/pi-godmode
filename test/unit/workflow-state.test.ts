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
  let current = ([
    "classified", "specified", "red-test-ready", "red-test-observed", "hand-running", "hand-handoff", "primary-verifying",
  ] as const).reduce((value, to) => applyPhaseTransition(value, { ...audit, to }), record);
  current = {
    ...current,
    primaryInspection: {
      id: "inspection-test", actor: "Primary", inspectedAt: audit.timestamp,
      statusReference: "artifact:status", completeDiffReference: "artifact:diff", diffFingerprint: "a".repeat(64),
      materiallyChangedPaths: ["src/workflow-state.ts"], outOfScopeChanges: [],
      independentChecks: [{ id: "check", command: "npm test", result: "passed", evidenceReference: "artifact:test" }], residualRisks: [],
    },
  };
  current = applyPhaseTransition(current, { ...audit, to: "evidence-ready" });
  current = applyPhaseTransition(current, { ...audit, to: "scale-running" });
  current = {
    ...current,
    scaleAdmission: {
      admissionId: `scale-admission-${"c".repeat(64)}`, nonce: "c".repeat(64), workItemId: current.workItemId,
      inspectionId: "inspection-test", diffFingerprint: "a".repeat(64), admittedAt: audit.timestamp, boundRunId: "scale-run-test",
    },
    scaleReview: {
      id: "scale-review-test", runId: "scale-run-test", admissionId: `scale-admission-${"c".repeat(64)}`, reviewer: "Scale", completedAt: audit.timestamp,
      freshContext: true, diffFingerprint: "a".repeat(64), evidenceReferences: ["artifact:status", "artifact:diff", "artifact:test"],
      verdict: "pass", findings: [], residualUncertainty: "none",
    },
  };
  return applyPhaseTransition(current, { ...audit, to: "review-passed" });
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
    requirementIds: ["FR-2"],
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

test("every non-draft canonical phase transition and persisted audit is Primary-only", () => {
  const pathTo = (phases: readonly Parameters<typeof applyPhaseTransition>[1]["to"][]) => {
    let current = workflowRecord();
    for (const to of phases) {
      if (to === "evidence-ready") {
        current = {
          ...current,
          primaryInspection: {
            id: "inspection-test", actor: "Primary", inspectedAt: audit.timestamp,
            statusReference: "artifact:status", completeDiffReference: "artifact:diff", diffFingerprint: "a".repeat(64),
            materiallyChangedPaths: ["src/workflow-state.ts"], outOfScopeChanges: [],
            independentChecks: [{ id: "check", command: "npm test", result: "passed", evidenceReference: "artifact:test" }], residualRisks: [],
          },
        };
      }
      current = applyPhaseTransition(current, { ...audit, to });
      if (to === "scale-running") {
        current = {
          ...current,
          scaleAdmission: {
            admissionId: `scale-admission-${"c".repeat(64)}`, nonce: "c".repeat(64), workItemId: current.workItemId,
            inspectionId: "inspection-test", diffFingerprint: "a".repeat(64), admittedAt: audit.timestamp, boundRunId: "scale-run-test",
          },
          scaleReview: {
            id: "scale-review-test", runId: "scale-run-test", admissionId: `scale-admission-${"c".repeat(64)}`, reviewer: "Scale", completedAt: audit.timestamp,
            freshContext: true, diffFingerprint: "a".repeat(64), evidenceReferences: ["artifact:status", "artifact:diff", "artifact:test"],
            verdict: "pass", findings: [], residualUncertainty: "none",
          },
        };
      }
    }
    return current;
  };
  const predecessors = {
    classified: [],
    specified: ["classified"],
    "red-test-ready": ["classified", "specified"],
    "red-test-observed": ["classified", "specified", "red-test-ready"],
    "tdd-waived": ["classified", "specified", "red-test-ready"],
    "hand-running": ["classified", "specified", "red-test-ready", "red-test-observed"],
    "hand-handoff": ["classified", "specified", "red-test-ready", "red-test-observed", "hand-running"],
    "primary-verifying": ["classified", "specified", "red-test-ready", "red-test-observed", "hand-running", "hand-handoff"],
    "evidence-ready": ["classified", "specified", "red-test-ready", "red-test-observed", "hand-running", "hand-handoff", "primary-verifying"],
    "scale-running": ["classified", "specified", "red-test-ready", "red-test-observed", "hand-running", "hand-handoff", "primary-verifying", "evidence-ready"],
    "review-passed": ["classified", "specified", "red-test-ready", "red-test-observed", "hand-running", "hand-handoff", "primary-verifying", "evidence-ready", "scale-running"],
    "scale-waived": ["classified", "specified", "red-test-ready", "red-test-observed", "hand-running", "hand-handoff", "primary-verifying", "evidence-ready"],
    accepted: ["classified", "specified", "red-test-ready", "red-test-observed", "hand-running", "hand-handoff", "primary-verifying", "evidence-ready", "scale-running", "review-passed"],
    remediation: ["classified", "specified", "red-test-ready", "red-test-observed", "hand-running", "hand-handoff", "primary-verifying", "evidence-ready", "scale-running"],
    blocked: [],
    rejected: ["classified", "specified", "red-test-ready", "red-test-observed", "hand-running", "hand-handoff", "primary-verifying", "evidence-ready", "scale-running", "review-passed"],
  } as const;
  for (const [target, phases] of Object.entries(predecessors)) {
    let predecessor = pathTo(phases);
    if (target === "evidence-ready") {
      predecessor = {
        ...predecessor,
        primaryInspection: {
          id: "inspection-test", actor: "Primary", inspectedAt: audit.timestamp,
          statusReference: "artifact:status", completeDiffReference: "artifact:diff", diffFingerprint: "a".repeat(64),
          materiallyChangedPaths: ["src/workflow-state.ts"], outOfScopeChanges: [],
          independentChecks: [{ id: "check", command: "npm test", result: "passed", evidenceReference: "artifact:test" }], residualRisks: [],
        },
      };
    }
    if (target === "scale-waived") {
      predecessor = {
        ...predecessor,
        scaleWaiver: {
          id: "scale-waiver-test", item: predecessor.workItemId, basis: "user-explicit", actor: "Primary", approver: "Primary",
          date: audit.timestamp, scope: "named gate", reason: "User explicitly approved this narrow review exception.", riskLimit: "Only this named gate.",
          compensatingEvidence: "artifact:compensation", userMessageEntryId: "user-entry",
        },
        scaleWaiverReference: "scale-waiver-test",
      };
    }
    if (target === "remediation") {
      predecessor = {
        ...predecessor,
        scaleReview: {
          ...predecessor.scaleReview!, verdict: "changes-required",
          findings: [{ id: "finding", classification: "fix-now", evidenceReference: "artifact:diff", summary: "Correction required." }],
        },
      };
    }
    if (target === "accepted") {
      for (const item of predecessor.roadmap) {
        predecessor = applyRoadmapTransition(predecessor, item.id, { ...audit, actor: "Hand", to: "implemented-unverified" });
        predecessor = applyRoadmapTransition(predecessor, item.id, { ...audit, to: "verified" });
      }
    }
    for (const actor of ["Eye", "Hand", "Scale"] as const) {
      assert.throws(
        () => applyPhaseTransition(predecessor, { ...audit, actor, to: target as Parameters<typeof applyPhaseTransition>[1]["to"] }),
        /Primary|authority/i,
        `${actor} unexpectedly authorized ${target}`,
      );
    }
    const authorized = applyPhaseTransition(predecessor, { ...audit, to: target as Parameters<typeof applyPhaseTransition>[1]["to"] });
    const forged = structuredClone(authorized);
    const last = forged.history.at(-1);
    if (last?.kind === "phase") last.actor = "Hand";
    assert.equal(validateWorkflowRecord(forged).ok, false, `forged persisted ${target} audit was accepted`);
  }
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
