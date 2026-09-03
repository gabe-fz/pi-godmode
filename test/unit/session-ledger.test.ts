import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  LEDGER_CUSTOM_TYPE,
  appendWorkflowSnapshot,
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

test("candidate-free recovery rejects malformed active-branch ordering and roots", () => {
  const root = customEntry("root", null, null, "unrelated");
  const child = customEntry("child", "root", null, "unrelated");
  for (const entries of [
    [child, root],
    [customEntry("orphan", "missing", null, "unrelated")],
  ]) {
    const result = reconstructActiveSnapshot(entries, "session-1", "work-1");
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") assert.match(result.reason, /branch|lineage|root|parent|order/i);
  }
});

test("recovery rejects malformed non-candidate entries beside a valid snapshot", () => {
  const entries = [
    customEntry("snapshot", null, snapshot(1)),
    customEntry("disconnected", "missing", null, "unrelated"),
  ];
  const result = reconstructActiveSnapshot(entries, "session-1", "work-1");
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.match(result.reason, /branch|lineage|root|parent|order/i);
});

test("append adapter creates monotonic snapshots from the active branch and verifies the new leaf", () => {
  const entries: SessionEntry[] = [];
  const sessionManager = {
    getSessionId: () => "session-1",
    getBranch: () => [...entries],
    getLeafEntry: () => entries.at(-1),
  };
  const pi = {
    appendEntry(customType: string, data: unknown) {
      entries.push(customEntry(`entry-${entries.length + 1}`, entries.at(-1)?.id ?? null, data, customType));
    },
  };

  const first = appendWorkflowSnapshot(pi, sessionManager, workflowRecord(), "2026-09-03T00:00:01.000Z");
  assert.equal(first.entryId, "entry-1");
  assert.equal(first.snapshot.generation, 1);
  assert.equal(first.snapshot.predecessorEntryId, null);

  const second = appendWorkflowSnapshot(pi, sessionManager, workflowRecord(), "2026-09-03T00:00:02.000Z");
  assert.equal(second.entryId, "entry-2");
  assert.equal(second.snapshot.generation, 2);
  assert.equal(second.snapshot.predecessorEntryId, "entry-1");
  assert.equal(reconstructActiveSnapshot(entries, "session-1", "work-1").status, "ok");
});

test("append adapter fails closed when the host does not acknowledge the exact new leaf", () => {
  const cases: Array<(snapshot: unknown) => SessionEntry | undefined> = [
    () => undefined,
    (data) => customEntry("wrong-parent", "unexpected", data),
    () => customEntry("wrong-payload", null, { wrong: true }),
  ];
  for (const makeLeaf of cases) {
    let leaf: SessionEntry | undefined;
    assert.throws(() => appendWorkflowSnapshot(
      { appendEntry(_customType, data) { leaf = makeLeaf(data); } },
      {
        getSessionId: () => "session-1",
        getBranch: () => [],
        getLeafEntry: () => leaf,
      },
      workflowRecord(),
      "2026-09-03T00:00:01.000Z",
    ), /append blocked/i);
  }
});

test("append verification bounds hostile getters and cyclic returned payloads", () => {
  for (const hostileLeaf of [
    new Proxy({} as SessionEntry, { get() { throw new Error("getter trap"); } }),
    (() => {
      const data: Record<string, unknown> = {};
      data.self = data;
      return customEntry("entry-1", null, data);
    })(),
  ]) {
    let leaf: SessionEntry | undefined;
    assert.throws(() => appendWorkflowSnapshot(
      { appendEntry() { leaf = hostileLeaf; } },
      {
        getSessionId: () => "session-1",
        getBranch: () => [],
        getLeafEntry: () => leaf,
      },
      workflowRecord(),
      "2026-09-03T00:00:01.000Z",
    ), /append blocked/i);
  }
});

test("branch reconstruction fails closed when ancestry exceeds its safety bound", () => {
  const entries: SessionEntry[] = [];
  for (let index = 0; index < 5_000; index += 1) {
    entries.push({
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      timestamp: "2026-09-03T00:00:00.000Z",
      type: "custom",
      customType: "unrelated",
      data: null,
    });
  }
  const result = reconstructActiveSnapshot(entries, "session-1", "work-1");
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.match(result.reason, /bound|limit|large/i);
});

test("append adapter refuses blocked ancestry and does not write", () => {
  const entries = [
    customEntry("entry-1", null, snapshot(1)),
    customEntry("entry-2", "entry-1", snapshot(3, "missing")),
  ];
  let writes = 0;
  assert.throws(() => appendWorkflowSnapshot(
    { appendEntry() { writes += 1; } },
    {
      getSessionId: () => "session-1",
      getBranch: () => entries,
      getLeafEntry: () => entries.at(-1),
    },
    workflowRecord(),
    "2026-09-03T00:00:03.000Z",
  ), /blocked|predecessor/i);
  assert.equal(writes, 0);
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
