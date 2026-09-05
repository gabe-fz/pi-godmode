import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPrimaryWorkflowController, WorkflowSchema } from "../../src/tools.ts";
import { renderAssignment, validateDelegation } from "../../src/faculties.ts";
import { appendWorkflowSnapshot, reconstructActiveSnapshot, type LedgerSessionManager } from "../../src/session-ledger.ts";
import { createWorkflowLifecycle } from "../../src/workflow-lifecycle.ts";
import { applyPhaseTransition } from "../../src/workflow-state.ts";
import { GodmodeMode } from "../../src/mode.ts";
import { ModelLease } from "../../src/model-lease.ts";
import { ASYNC_COMPLETE_EVENT, RPC_REQUEST_EVENT, SubagentsClient, type EventBus } from "../../src/subagents-client.ts";
import { validConfig } from "../fixtures/config.ts";
import { workflowRecord } from "../fixtures/workflow.ts";
import type { ThinkingLevel, WorkflowRecord } from "../../src/types.ts";
import { test } from "node:test";

const PING = {
  version: 1,
  methods: ["ping", "spawn", "status", "steer", "stop"],
  capabilities: { asyncSpawn: true, nonRecoveringSteer: true, stop: true, status: true, fleetStatus: { version: 1 }, processTerminalProof: { version: 1 } },
  events: { asyncComplete: ASYNC_COMPLETE_EVENT },
};

class ModeBus implements EventBus {
  readonly handlers = new Map<string, Set<(value: unknown) => void>>();
  on(event: string, handler: (value: unknown) => void): () => void {
    const set = this.handlers.get(event) ?? new Set<(value: unknown) => void>();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }
  emit(event: string, value: unknown): void {
    if (event === RPC_REQUEST_EVENT) {
      const request = value as { method: string; requestId: string };
      const data = request.method === "ping" ? PING
        : request.method === "spawn" ? { details: { runId: "phase2-run" } }
          : request.method === "status" ? { asyncSnapshot: { runs: [{ id: "phase2-run", state: "running" }] } }
            : { deliveryStatus: "delivered" };
      queueMicrotask(() => this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data }));
    }
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }
}

function checkout(): { root: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), "godmode-phase2-runtime-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "feature.ts"), "export const feature = false;\n");
  const source = "import assert from 'node:assert/strict';\nassert.equal(false, true);\n";
  writeFileSync(join(root, "test", "feature.test.ts"), source);
  return { root, source };
}

function controller(root: string, initialRecord?: WorkflowRecord, priorRecords: WorkflowRecord[] = []) {
  const manager = SessionManager.create(root, join(root, "sessions"));
  for (const prior of priorRecords) {
    appendWorkflowSnapshot(
      { appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); } },
      manager,
      prior,
      "2026-09-04T00:58:59.000Z",
    );
  }
  if (initialRecord) {
    appendWorkflowSnapshot(
      { appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); } },
      manager,
      initialRecord,
      "2026-09-04T00:59:59.000Z",
    );
  }
  let appendCount = 0;
  let record: WorkflowRecord | undefined = initialRecord;
  const instance = createPrimaryWorkflowController({
    pi: { appendEntry: (customType, data) => { appendCount += 1; manager.appendCustomEntry(customType, data); } },
    getSessionManager: () => manager,
    getWorkflowRecord: () => record,
    setWorkflowRecord: (next) => { record = next; },
    cwd: () => root,
    now: () => "2026-09-04T01:00:00.000Z",
  });
  return { manager, instance, getRecord: () => record, getAppendCount: () => appendCount };
}

function blockedRecord(workItemId = "blocked-old"): WorkflowRecord {
  return applyPhaseTransition(workflowRecord({ workItemId }), {
    actor: "Primary",
    timestamp: "2026-09-04T00:59:59.000Z",
    reason: "The prior bounded attempt cannot continue.",
    reference: `run:${workItemId}`,
    to: "blocked",
  });
}

function specify(instance: ReturnType<typeof createPrimaryWorkflowController>, classification: "feature" | "bugfix" | "documentation/configuration", workItemId = `${classification}-1`) {
  return instance.execute({
    action: "specify",
    workItemId,
    classification,
    goal: "An actor can observe the approved behavior through the named interface under the packet constraints.",
    requirementIds: ["FR-1"],
    functionalRequirements: [{ id: "FR-1", description: "The requested behavior is observable through the supported interface.", interface: "library interface" }],
    nonGoals: ["No unrelated behavior or release changes."],
    expectedPaths: ["src/feature.ts", "test/feature.test.ts"],
    roadmap: [{ id: "implement-fr-1", requirementIds: ["FR-1"], title: "Implement and verify FR-1" }],
    acceptanceChecks: ["node --test test/feature.test.ts"],
    authorityConstraints: ["Hand may change only the narrowed mutation paths and must preserve the immutable red test."],
  });
}

test("a valid blocked packet is superseded only by a fresh distinct work item", () => {
  const { root } = checkout();
  const blocked = blockedRecord();
  const runtime = controller(root, blocked);
  const blockedLeaf = runtime.manager.getLeafEntry();
  assert(blockedLeaf);

  const result = specify(runtime.instance, "bugfix");

  assert.equal(result.workItemId, "bugfix-1");
  assert.equal(result.phase, "red-test-ready");
  assert.equal(runtime.getRecord()?.workItemId, "bugfix-1");
  const active = reconstructActiveSnapshot(runtime.manager.getBranch(), runtime.manager.getSessionId(), "bugfix-1");
  assert.equal(active.status, "ok");
  assert.equal(active.status === "ok" ? active.snapshot.record.phase : undefined, "red-test-ready");
  assert.equal(active.status === "ok" ? active.snapshot.generation : undefined, 1);
  assert.equal(active.status === "ok" ? active.snapshot.predecessorEntryId : undefined, null);
  const activeEntry = runtime.manager.getBranch().find((entry) => entry.id === active.entryId);
  assert.equal(activeEntry?.parentId, blockedLeaf.id, "the fresh root remains on the blocked packet's append branch");
  const prior = reconstructActiveSnapshot(runtime.manager.getBranch(), runtime.manager.getSessionId(), "blocked-old");
  assert.equal(prior.status, "ok");
  assert.equal(prior.status === "ok" ? prior.snapshot.record.phase : undefined, "blocked");
  assert.equal(runtime.getAppendCount(), 1, "a valid supersession performs exactly one append");
});

test("lifecycle recovery selects the fresh packet and leaves the blocked predecessor inert", () => {
  const { root } = checkout();
  const runtime = controller(root, blockedRecord());
  specify(runtime.instance, "bugfix");

  const restored: Array<WorkflowRecord | undefined> = [];
  const views: unknown[] = [];
  const blockedReasons: Array<string | undefined> = [];
  const lifecycle = createWorkflowLifecycle({
    pi: { appendEntry: () => { throw new Error("startup recovery must not append"); } },
    setWorkflowRecord: (record) => { restored.push(record); },
    setWorkflowView: (view) => { views.push(view); },
    setWorkflowBlockedReason: (reason) => { blockedReasons.push(reason); },
    refresh: () => {},
  });
  lifecycle.sessionStart({ type: "session_start", reason: "startup" } as never, { sessionManager: runtime.manager } as never);

  assert.equal(restored.at(-1)?.workItemId, "bugfix-1");
  assert.equal(restored.at(-1)?.phase, "red-test-ready");
  assert.notEqual(views.at(-1), undefined);
  assert.equal(blockedReasons.at(-1), undefined);
  const prior = reconstructActiveSnapshot(runtime.manager.getBranch(), runtime.manager.getSessionId(), "blocked-old");
  assert.equal(prior.status, "ok");
  assert.equal(prior.status === "ok" ? prior.snapshot.record.phase : undefined, "blocked");
  assert.equal(runtime.getAppendCount(), 1, "recovery is read-only after supersession");
});

test("same and historical work-item IDs fail closed without appending", () => {
  const same = controller(checkout().root, blockedRecord("bugfix-1"));
  assert.throws(() => specify(same.instance, "bugfix"), /distinct|fresh/i);
  assert.equal(same.getAppendCount(), 0, "same-ID supersession must not append");

  const historical = controller(
    checkout().root,
    blockedRecord(),
    [workflowRecord({ workItemId: "historical-1" })],
  );
  assert.throws(() => specify(historical.instance, "bugfix", "historical-1"), /fresh|history/i);
  assert.equal(historical.getAppendCount(), 0, "historical-ID supersession must not append");
});

test("non-blocked and conflicting persisted authorities fail closed without appending", () => {
  const draft = controller(checkout().root, workflowRecord({ workItemId: "draft-1" }));
  assert.throws(() => specify(draft.instance, "bugfix"), /blocked|packet|supersed/i);
  assert.equal(draft.getAppendCount(), 0, "draft replacement must not append");

  const activeRecord = applyPhaseTransition(blockedRecord("active-1"), {
    actor: "Primary",
    timestamp: "2026-09-04T01:00:00.000Z",
    reason: "The active packet is not eligible for replacement.",
    reference: "run:active-1",
    to: "red-test-ready",
  });
  const active = controller(checkout().root, activeRecord);
  assert.throws(() => specify(active.instance, "bugfix"), /blocked|packet|supersed/i);
  assert.equal(active.getAppendCount(), 0, "active replacement must not append");

  const inconsistent = blockedRecord();
  const runtime = controller(checkout().root, inconsistent);
  inconsistent.goal = "A runtime-only authority that is not persisted.";
  assert.throws(() => specify(runtime.instance, "bugfix"), /conflict|authority|blocked/i);
  assert.equal(runtime.getAppendCount(), 0, "conflicting runtime authority must not append");

  const malformed = controller(checkout().root, blockedRecord());
  malformed.manager.appendCustomEntry("godmode-workflow-ledger", { malformed: true });
  assert.throws(() => specify(malformed.instance, "bugfix"), /malformed|persisted|blocked/i);
  assert.equal(malformed.getAppendCount(), 0, "malformed persisted authority must not append");
});

test("blocked supersession rejects accessor-backed persisted authority without appending", () => {
  const runtime = controller(checkout().root, blockedRecord());
  const ledgerEntry = runtime.manager.getBranch().find((entry) => entry.type === "custom" && entry.customType === "godmode-workflow-ledger");
  assert(ledgerEntry && ledgerEntry.type === "custom");
  const persistedData = ledgerEntry.data;
  let getterReads = 0;
  Object.defineProperty(ledgerEntry, "data", {
    configurable: true,
    enumerable: true,
    get: () => {
      getterReads += 1;
      return persistedData;
    },
  });

  assert.throws(() => specify(runtime.instance, "bugfix"), /authority|blocked|recovery/i);
  assert.equal(getterReads, 0, "accessor-backed persisted authority must be rejected without invoking the getter");
  assert.equal(runtime.getAppendCount(), 0, "accessor-backed persisted authority must not append");
});

test("blocked supersession rejects accessor-backed runtime authority without appending", () => {
  const blocked = blockedRecord();
  const runtime = controller(checkout().root, blocked);
  const persistedGoal = blocked.goal;
  let getterReads = 0;
  Object.defineProperty(blocked, "goal", {
    configurable: true,
    enumerable: true,
    get: () => {
      getterReads += 1;
      return persistedGoal;
    },
  });

  assert.throws(() => specify(runtime.instance, "bugfix"), /authority|blocked|recovery/i);
  assert.equal(getterReads, 0, "runtime accessor-backed authority must be rejected before validation reads it");
  assert.equal(runtime.getAppendCount(), 0, "runtime accessor-backed authority must not append");
});

test("blocked supersession validates the owned runtime clone without reading the original", () => {
  const blocked = blockedRecord();
  let runtimeReads = 0;
  const runtimeRecord = new Proxy(blocked, {
    get(target, property, receiver) {
      runtimeReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const runtime = controller(checkout().root, runtimeRecord);
  runtimeReads = 0;

  const result = specify(runtime.instance, "bugfix");

  assert.equal(result.workItemId, "bugfix-1");
  assert.equal(runtimeReads, 0, "validation and proof must use the owned clone, not the caller-owned record");
  assert.equal(runtime.getAppendCount(), 1);
});

test("a supersession append is accepted only after exact leaf acknowledgement", () => {
  const { root } = checkout();
  const blocked = blockedRecord();
  const manager = SessionManager.create(root, join(root, "sessions"));
  appendWorkflowSnapshot(
    { appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); } },
    manager,
    blocked,
    "2026-09-04T00:59:59.000Z",
  );
  let record: WorkflowRecord | undefined = blocked;
  let appendCount = 0;
  const instance = createPrimaryWorkflowController({
    pi: { appendEntry: () => { appendCount += 1; } },
    getSessionManager: () => manager,
    getWorkflowRecord: () => record,
    setWorkflowRecord: (next) => { record = next; },
    cwd: () => root,
    now: () => "2026-09-04T01:00:00.000Z",
  });

  assert.throws(() => specify(instance, "bugfix"), /acknowledge|leaf|append/i);
  assert.equal(appendCount, 1, "the attempted append is not mistaken for acknowledgement");
  assert.equal(record, blocked, "runtime authority stays unchanged after acknowledgement failure");
  const fresh = reconstructActiveSnapshot(manager.getBranch(), manager.getSessionId(), "bugfix-1");
  assert.equal(fresh.status, "absent");
});

test("blocked supersession rejects an oversized active branch before any append", () => {
  const { root } = checkout();
  const blocked = applyPhaseTransition(workflowRecord({ workItemId: "blocked-old" }), {
    actor: "Primary",
    timestamp: "2026-09-04T00:59:59.000Z",
    reason: "The prior bounded attempt cannot continue.",
    reference: "run:blocked-old",
    to: "blocked",
  });
  const branch = Array.from({ length: 1_025 }, (_, index) => ({
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    type: "message",
    timestamp: "2026-09-04T00:59:59.000Z",
  }));
  let branchEntryReads = 0;
  const hostileBranch = new Proxy(branch, {
    get(target, property, receiver) {
      if (/^\d+$/u.test(String(property))) branchEntryReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  let appendCount = 0;
  const manager = {
    getSessionId: () => "session-1",
    getBranch: () => hostileBranch,
    getLeafEntry: () => branch.at(-1),
  } as unknown as LedgerSessionManager;
  const instance = createPrimaryWorkflowController({
    pi: { appendEntry: () => { appendCount += 1; } },
    getSessionManager: () => manager,
    getWorkflowRecord: () => blocked,
    setWorkflowRecord: () => {},
    cwd: () => root,
    now: () => "2026-09-04T01:00:00.000Z",
  });

  assert.throws(() => specify(instance, "bugfix"), /recovery|blocked|bounded/i);
  assert.equal(branchEntryReads, 0, "oversized branches are rejected before entry iteration");
  assert.equal(appendCount, 0);
});

test("blocked supersession fails closed when the active branch swaps after proof", () => {
  const { root } = checkout();
  const backing = SessionManager.create(root, join(root, "sessions"));
  const blocked = blockedRecord();
  appendWorkflowSnapshot(
    { appendEntry: (customType, data) => { backing.appendCustomEntry(customType, data); } },
    backing,
    blocked,
    "2026-09-04T00:59:59.000Z",
  );
  const capturedBranch = backing.getBranch();
  const capturedLeaf = capturedBranch.at(-1);
  assert(capturedLeaf);
  const swappedBranch = capturedBranch.map((entry, index) => index === capturedBranch.length - 1
    ? { ...entry, id: `${entry.id}-swapped` }
    : entry);
  let branchReads = 0;
  const manager: LedgerSessionManager = {
    getSessionId: () => backing.getSessionId(),
    getBranch: () => {
      branchReads += 1;
      return branchReads >= 2 ? swappedBranch : capturedBranch;
    },
    getLeafEntry: () => branchReads >= 2 ? swappedBranch.at(-1) : capturedLeaf,
    getHeader: () => backing.getHeader(),
  };
  let appendCount = 0;
  const instance = createPrimaryWorkflowController({
    pi: { appendEntry: () => { appendCount += 1; } },
    getSessionManager: () => manager,
    getWorkflowRecord: () => blocked,
    setWorkflowRecord: () => {},
    cwd: () => root,
    now: () => "2026-09-04T01:00:00.000Z",
  });

  assert.throws(() => specify(instance, "bugfix"), /append|authority|changed|blocked/i);
  assert.equal(appendCount, 0, "a swapped branch must be rejected before append");
});

test("a forked blocked packet can be superseded by a fresh item and recovered after reload", () => {
  const { root } = checkout();
  const parent = SessionManager.create(root, join(root, "sessions"));
  const blocked = blockedRecord();
  appendWorkflowSnapshot(
    { appendEntry: (customType, data) => { parent.appendCustomEntry(customType, data); } },
    parent,
    blocked,
    "2026-09-04T00:59:59.000Z",
  );
  parent.appendMessage({
    role: "assistant",
    content: [],
    timestamp: Date.now(),
    api: "fixture",
    provider: "fixture",
    model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
  });
  const parentFile = parent.getSessionFile();
  const parentLeaf = parent.getLeafEntry();
  assert(parentFile);
  assert(parentLeaf);
  const forkFile = parent.createBranchedSession(parentLeaf.id);
  assert(forkFile);
  const fork = SessionManager.open(forkFile);
  let restored: WorkflowRecord | undefined;
  const blockedReasons: string[] = [];
  createWorkflowLifecycle({
    pi: { appendEntry: (customType, data) => { fork.appendCustomEntry(customType, data); } },
    setWorkflowRecord: (record) => { restored = record; },
    setWorkflowView: () => {},
    setWorkflowBlockedReason: (reason) => { if (reason) blockedReasons.push(reason); },
    refresh: () => {},
    now: () => "2026-09-04T01:00:00.000Z",
  }).sessionStart({
    type: "session_start",
    reason: "fork",
    previousSessionFile: parentFile,
  } as never, { sessionManager: fork } as never);

  assert.equal(blockedReasons.length, 0);
  assert(restored);
  assert.equal(restored.workItemId, blocked.workItemId);
  assert.equal(restored.phase, "blocked");
  let runtimeRecord: WorkflowRecord | undefined = restored;
  let appendCount = 0;
  const instance = createPrimaryWorkflowController({
    pi: { appendEntry: (customType, data) => { appendCount += 1; fork.appendCustomEntry(customType, data); } },
    getSessionManager: () => fork,
    getWorkflowRecord: () => runtimeRecord,
    setWorkflowRecord: (record) => { runtimeRecord = record; },
    cwd: () => root,
    now: () => "2026-09-04T01:01:00.000Z",
  });

  const result = specify(instance, "bugfix", "fork-fresh-1");
  assert.equal(result.workItemId, "fork-fresh-1");
  assert.equal(result.phase, "red-test-ready");
  assert.equal(appendCount, 1);

  const reopened = SessionManager.open(forkFile);
  const recoveryContext = {
    sessionId: reopened.getHeader()?.id,
    parentSessionFile: reopened.getHeader()?.parentSession,
  };
  const fresh = reconstructActiveSnapshot(reopened.getBranch(), reopened.getSessionId(), "fork-fresh-1", recoveryContext);
  assert.equal(fresh.status, "ok");
  if (fresh.status === "ok") {
    assert.equal(fresh.snapshot.record.phase, "red-test-ready");
    assert.equal(fresh.snapshot.generation, 1);
    assert.equal(fresh.snapshot.predecessorEntryId, null);
  }
  const prior = reconstructActiveSnapshot(reopened.getBranch(), reopened.getSessionId(), blocked.workItemId, recoveryContext);
  assert.equal(prior.status, "ok");
  assert.equal(prior.status === "ok" ? prior.snapshot.record.phase : undefined, "blocked");
});

test("normal Primary controller persists fresh feature and bugfix packets through red admission", () => {
  for (const classification of ["feature", "bugfix"] as const) {
    const { root, source } = checkout();
    const { manager, instance, getRecord } = controller(root);
    assert.equal(specify(instance, classification).phase, "red-test-ready");
    const red = instance.execute({
      action: "record-red",
      testPath: "test/feature.test.ts",
      command: "node --test test/feature.test.ts",
      environment: "Disposable local checkout with Node.js test runner.",
      exitStatus: 1,
      failureKind: "missing-behavior",
      requirementIds: ["FR-1"],
      outputExcerpt: "Expected false to equal true",
    });
    assert.equal(red.phase, "red-test-observed");
    assert.equal(getRecord()?.redTestEvidence?.testContentHash, createHash("sha256").update(source).digest("hex"));
    const recovered = reconstructActiveSnapshot(manager.getBranch(), manager.getSessionId(), `${classification}-1`);
    assert.equal(recovered.status, "ok");
    assert.equal(recovered.status === "ok" ? recovered.snapshot.record.phase : undefined, "red-test-observed");
    assert.equal(getRecord()?.phase, "red-test-observed");
    const persistedRecord = recovered.status === "ok" ? recovered.snapshot.record : undefined;
    const normalized = validateDelegation({ faculty: "hand", title: "Implement", task: "Implement", expectedPaths: ["src/feature.ts"], acceptanceChecks: ["node --test test/feature.test.ts"] }, root, persistedRecord);
    const assignment = renderAssignment(normalized);
    assert.match(assignment, /requested behavior is observable/);
    assert.match(assignment, /interface: library interface/);
    assert.match(assignment, /immutable red-test prohibition/i);
  }
});

test("normal Primary controller records a documentation-only narrow waiver and rejects malformed red/setup claims", () => {
  const { root } = checkout();
  const { instance } = controller(root);
  specify(instance, "documentation/configuration");
  assert.throws(() => instance.execute({
    action: "record-red",
    testPath: "test/feature.test.ts",
    command: "node --test test/feature.test.ts",
    exitStatus: 1,
    failureKind: "missing-behavior",
    requirementIds: ["FR-1"],
    outputExcerpt: "Expected false to equal true",
  }), /environment/i);
  assert.throws(() => instance.execute({
    action: "record-red",
    testPath: "test/feature.test.ts",
    command: "node --test test/feature.test.ts",
    environment: "",
    exitStatus: 1,
    failureKind: "missing-behavior",
    requirementIds: ["FR-1"],
    outputExcerpt: "Expected false to equal true",
  }), /environment/i);
  assert.throws(() => instance.execute({
    action: "record-red",
    testPath: "test/feature.test.ts",
    command: "node --test test/feature.test.ts",
    environment: "Disposable local checkout with Node.js test runner.",
    exitStatus: 1,
    failureKind: "setup-failure",
    requirementIds: ["FR-1"],
    outputExcerpt: "dependency missing",
  }), /missing-behavior|setup|unrelated|red/i);
  const waiver = instance.execute({
    action: "waive-tdd",
    requirementIds: ["FR-1"],
    inapplicableSeam: "No executable seam applies to documentation-only behavior.",
    reason: "Documentation only; no executable behavior changes.",
    scope: ["src/feature.ts"],
    compensatingCheck: "node --test test/feature.test.ts",
  });
  assert.equal(waiver.phase, "tdd-waived");
});

test("workflow authoring schema and controller exclude caller authority and preserve packet requirement descriptions", () => {
  const schema = Compile(WorkflowSchema);
  assert.equal(schema.Check({ action: "specify", actor: "Hand" }), false);
  assert.equal(schema.Check({ action: "specify", phase: "accepted" }), false);
  const { root } = checkout();
  const { instance } = controller(root);
  assert.throws(() => instance.execute({ action: "specify", actor: "Hand" }), /authority/i);
  const blocked = controller(checkout().root);
  blocked.manager.appendCustomEntry("godmode-workflow-ledger", { malformed: true });
  assert.throws(() => specify(blocked.instance, "feature"), /persisted|malformed|blocked|recovery/i);
  const packet = workflowRecord({
    phase: "draft",
    requirementIds: ["FR-1"],
    functionalRequirements: [{ id: "FR-1", description: "An observable packet behavior.", interface: "API" }],
  });
  assert.equal(packet.functionalRequirements?.[0]?.description, "An observable packet behavior.");
});

test("schema-v1 legacy drafts without Phase 2 packet fields remain recoverable but cannot admit Hand", () => {
  const { root } = checkout();
  const manager = SessionManager.create(root, join(root, "sessions"));
  const legacy = workflowRecord();
  delete legacy.functionalRequirements;
  delete legacy.packetAuthor;
  delete legacy.acceptanceChecks;
  delete legacy.authorityConstraints;
  appendWorkflowSnapshot(
    { appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); } },
    manager,
    legacy,
    "2026-09-04T01:00:00.000Z",
  );
  const recovered = reconstructActiveSnapshot(manager.getBranch(), manager.getSessionId(), legacy.workItemId);
  assert.equal(recovered.status, "ok");
  const record = recovered.status === "ok" ? recovered.snapshot.record : undefined;
  assert.throws(() => validateDelegation({
    faculty: "hand", title: "Implement", task: "Implement", expectedPaths: ["src/feature.ts"], acceptanceChecks: ["npm test"],
  }, root, record), /packet|phase|red|waiver/i);
});

test("Hand accepts deliberate scope narrowing while keeping the immutable red test outside mutation authority", () => {
  const { root, source } = checkout();
  const record = workflowRecord({
    workItemId: "scope-1",
    classification: "feature",
    requirementIds: ["FR-1"],
    functionalRequirements: [{ id: "FR-1", description: "Observable feature behavior.", interface: "API" }],
    expectedPaths: ["src/feature.ts", "test/feature.test.ts"],
    roadmap: [{ id: "item-1", requirementIds: ["FR-1"], title: "Feature", status: "pending" }],
    phase: "red-test-observed",
    history: [
      { kind: "phase", workItemId: "scope-1", from: "draft", to: "classified", actor: "Primary", timestamp: "2026-09-04T00:00:00.000Z", reason: "classify", reference: "r1" },
      { kind: "phase", workItemId: "scope-1", from: "classified", to: "specified", actor: "Primary", timestamp: "2026-09-04T00:00:00.000Z", reason: "specify", reference: "r2" },
      { kind: "phase", workItemId: "scope-1", from: "specified", to: "red-test-ready", actor: "Primary", timestamp: "2026-09-04T00:00:00.000Z", reason: "red gate", reference: "r3" },
      { kind: "phase", workItemId: "scope-1", from: "red-test-ready", to: "red-test-observed", actor: "Primary", timestamp: "2026-09-04T00:00:00.000Z", reason: "red", reference: "r4" },
    ],
    redTestEvidence: {
      id: "red-1", command: "node --test test/feature.test.ts", environment: "Disposable local checkout with Node.js test runner.", exitStatus: 1, requirementIds: ["FR-1"],
      testPath: "test/feature.test.ts", testContentHash: createHash("sha256").update(source).digest("hex"),
      observedBy: "Primary", observedAt: "2026-09-04T00:00:00.000Z", failureKind: "missing-behavior", outputExcerpt: "red",
    },
  });
  const hand = {
    faculty: "hand" as const, title: "Implement", task: "Implement", expectedPaths: ["src/feature.ts"], acceptanceChecks: ["npm test"],
  };
  assert.doesNotThrow(() => validateDelegation(hand, root, record));
  assert.throws(() => validateDelegation({ ...hand, expectedPaths: ["src/feature.ts", "README.md"] }, root, record), /scope|expand/i);
});

test("sticky red-test monitoring rejects a change-then-restore before Hand handoff", async () => {
  const { root, source } = checkout();
  const red = {
    id: "red-1", command: "node --test test/feature.test.ts", environment: "Disposable local checkout with Node.js test runner.", exitStatus: 1, requirementIds: ["FR-1"],
    testPath: "test/feature.test.ts", testContentHash: createHash("sha256").update(source).digest("hex"),
    observedBy: "Primary" as const, observedAt: "2026-09-04T00:00:00.000Z", failureKind: "missing-behavior" as const, outputExcerpt: "red",
  };
  let record = workflowRecord({
    workItemId: "monitor-1", classification: "feature", requirementIds: ["FR-1"],
    functionalRequirements: [{ id: "FR-1", description: "Observable feature behavior.", interface: "API" }],
    expectedPaths: ["src/feature.ts", "test/feature.test.ts"],
    roadmap: [{ id: "item-1", requirementIds: ["FR-1"], title: "Feature", status: "pending" }],
    phase: "red-test-observed", redTestEvidence: red, redTestReference: red.id,
    history: [
      { kind: "phase", workItemId: "monitor-1", from: "draft", to: "classified", actor: "Primary", timestamp: "2026-09-04T00:00:00.000Z", reason: "classify", reference: "r1" },
      { kind: "phase", workItemId: "monitor-1", from: "classified", to: "specified", actor: "Primary", timestamp: "2026-09-04T00:00:00.000Z", reason: "specify", reference: "r2" },
      { kind: "phase", workItemId: "monitor-1", from: "specified", to: "red-test-ready", actor: "Primary", timestamp: "2026-09-04T00:00:00.000Z", reason: "red gate", reference: "r3" },
      { kind: "phase", workItemId: "monitor-1", from: "red-test-ready", to: "red-test-observed", actor: "Primary", timestamp: "2026-09-04T00:00:00.000Z", reason: "red", reference: "r4" },
    ],
  });
  const bus = new ModeBus();
  const client = new SubagentsClient(bus, { timeoutMs: 1_000 });
  let model = { provider: "old", id: "model" };
  let thinking: ThinkingLevel = "high";
  let redEvent: (() => void) | undefined;
  const transitions: string[] = [];
  const mode = new GodmodeMode({
    client, modelLease: new ModelLease(),
    modelHost: {
      findModel: (provider, id) => ({ provider, id }), isModelScoped: () => true,
      setModel: async (next) => { model = next; return true; }, getModel: () => model,
      getThinkingLevel: () => thinking, setThinkingLevel: (level) => { thinking = level; },
    },
    loadConfig: async () => validConfig(), isTrusted: () => true, cwd: () => root, sessionId: () => "session-monitor",
    getWorkflowRecord: () => record,
    persistWorkflowTransition: (to, reason, reference) => {
      record = applyPhaseTransition(record, { to, actor: "Primary", timestamp: "2026-09-04T00:00:00.000Z", reason, reference });
      transitions.push(to);
      return record;
    },
    monitorRedTest: (_identity, onEvent) => { redEvent = onEvent; return { dispose() {} }; },
    validateFacultyModels: () => {}, registerFaculties: () => [], registerCeiling: () => ({ dispose() {} }),
    preflight: async () => {}, acquireTools: () => {}, releaseTools: () => {},
  });
  await mode.enable();
  await mode.delegate({ faculty: "hand", title: "Implement", task: "Implement", expectedPaths: ["src/feature.ts"], acceptanceChecks: ["npm test"] });
  writeFileSync(join(root, "test", "feature.test.ts"), "changed");
  writeFileSync(join(root, "test", "feature.test.ts"), source);
  redEvent?.();
  bus.emit(ASYNC_COMPLETE_EVENT, { runId: "phase2-run", success: true });
  assert.equal(mode.snapshot.lastRun?.state, "failed");
  assert.deepEqual(transitions, ["hand-running", "blocked"]);
  assert.equal(record.phase, "blocked");
});
