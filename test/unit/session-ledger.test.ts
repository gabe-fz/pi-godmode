import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  LEDGER_CUSTOM_TYPE,
  createCompletionCapsule,
  createLedgerSnapshot,
  projectWorkflowRecord,
  reconstructActiveSnapshot,
  sanitizeLedgerValue,
} from "../../src/session-ledger.ts";
import { applyPhaseTransition, applyRoadmapTransition } from "../../src/workflow-state.ts";
import { workflowRecord } from "../fixtures/workflow.ts";

const audit = {
  actor: "Primary" as const,
  timestamp: "2026-09-03T00:00:00.000Z",
  reason: "Observed controlled evidence.",
  reference: "evidence:test-1",
};

function advanceToReview(record = workflowRecord()) {
  return ([
    "classified", "specified", "red-test-ready", "red-test-observed",
    "hand-running", "hand-handoff", "primary-verifying", "evidence-ready",
    "scale-running", "review-passed",
  ] as const).reduce((current, to) => applyPhaseTransition(current, { ...audit, to }), record);
}

function customEntry(
  id: string,
  parentId: string | null,
  data: unknown,
  customType = LEDGER_CUSTOM_TYPE,
): SessionEntry {
  return { id, parentId, timestamp: "2026-09-03T00:00:00.000Z", type: "custom", customType, data };
}

function snapshot(generation: number, predecessorEntryId: string | null = null) {
  return createLedgerSnapshot({
    sessionId: "session-1",
    workItemId: "work-1",
    generation,
    predecessorEntryId,
    createdAt: `2026-09-03T00:00:0${generation}.000Z`,
    record: workflowRecord(),
  });
}

test("active-branch reconstruction follows generation and predecessor lineage", () => {
  const first = customEntry("entry-1", null, snapshot(1));
  const second = customEntry("entry-2", "entry-1", snapshot(2, "entry-1"));
  const result = reconstructActiveSnapshot([first, second], "session-1", "work-1");
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.entryId, "entry-2");
    assert.equal(result.snapshot.generation, 2);
  }
});

test("off-branch snapshots are ignored because callers provide only getBranch ancestry", () => {
  const active = customEntry("entry-1", null, snapshot(1));
  const unrelated = customEntry("other", "elsewhere", { ...snapshot(99), predecessorEntryId: null });
  const result = reconstructActiveSnapshot([active], "session-1", "work-1");
  assert.equal(result.status, "ok");
  assert.notEqual((active as { id: string }).id, (unrelated as { id: string }).id);
});

test("conflicting, broken, or cross-session lineage fails closed", () => {
  const cases: SessionEntry[][] = [
    [customEntry("a", null, snapshot(1)), customEntry("b", "a", snapshot(1, "a"))],
    [customEntry("a", null, snapshot(1)), customEntry("b", "a", snapshot(3, "missing"))],
    [customEntry("a", null, snapshot(1)), customEntry("b", "a", { ...snapshot(2, "a"), sessionId: "other" })],
    [customEntry("a", "missing-root", snapshot(1))],
  ];
  for (const entries of cases) {
    const result = reconstructActiveSnapshot(entries, "session-1", "work-1");
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") assert.match(result.reason, /generation|predecessor|session|root|lineage/i);
  }
});

test("absence is distinct from blocked recovery", () => {
  assert.deepEqual(reconstructActiveSnapshot([], "session-1", "work-1"), { status: "absent" });
});

test("ledger serialization redacts sensitive keys and secret-like values before persistence", () => {
  const sanitized = sanitizeLedgerValue({
    authorization: "Bearer top-secret",
    nested: { apiKey: "sk-live-secret", safe: "visible" },
    signedUrl: "https://example.test/file?X-Amz-Signature=secret",
  });
  const text = JSON.stringify(sanitized);
  assert(!text.includes("top-secret"));
  assert(!text.includes("sk-live-secret"));
  assert(!text.includes("X-Amz-Signature=secret"));
  assert(text.includes("visible"));
  assert(text.includes("[REDACTED]"));
});

test("active projection is deterministic and never exceeds 2 KiB UTF-8", () => {
  const base = workflowRecord({
    goal: "optional detail ".repeat(500),
    blockers: ["awaiting controlled restart"],
    residualRisks: ["checkout fingerprint not yet compared"],
    tddWaiverReference: "decision:tdd-1",
    scaleWaiverReference: "decision:scale-1",
  });
  const implemented = applyRoadmapTransition(base, "item-1", {
    ...audit,
    actor: "Hand",
    to: "implemented-unverified",
  });
  const record = applyRoadmapTransition(implemented, "item-2", { ...audit, to: "blocked" });
  const first = projectWorkflowRecord(record);
  const second = projectWorkflowRecord(record);
  assert.deepEqual(first, second);
  assert(Buffer.byteLength(first.text, "utf8") <= 2_048);
  assert.equal(first.truncated, true);
  assert.equal(first.blocked, false);
  const projection = JSON.parse(first.text) as Record<string, unknown>;
  assert.deepEqual(projection.roadmap, [
    { id: "item-1", status: "implemented-unverified" },
    { id: "item-2", status: "blocked" },
  ]);
  assert.deepEqual(projection.blockers, record.blockers);
  assert.deepEqual(projection.residualRisks, record.residualRisks);
  assert.equal(projection.tddWaiverReference, "decision:tdd-1");
  assert.equal(projection.scaleWaiverReference, "decision:scale-1");
});

test("projection fails closed rather than dropping oversized required state", () => {
  for (const record of [
    workflowRecord({ workItemId: "界".repeat(1_000) }),
    workflowRecord({ blockers: ["界".repeat(1_000)] }),
    workflowRecord({ residualRisks: ["界".repeat(1_000)] }),
  ]) {
    const result = projectWorkflowRecord(record);
    assert.equal(result.blocked, true);
    assert.match(result.reason ?? "", /2 KiB|required/i);
  }
});

test("completion capsules are bounded, redacted, and do not imply acceptance", () => {
  const capsule = createCompletionCapsule(advanceToReview(workflowRecord({
    residualRisks: ["token=super-secret", "risk ".repeat(1_000)],
  })), "2026-09-03T00:00:00.000Z");
  const text = JSON.stringify(capsule);
  assert(Buffer.byteLength(text, "utf8") <= 2_048);
  assert(!text.includes("super-secret"));
  assert.equal(capsule.accepted, false);
});
