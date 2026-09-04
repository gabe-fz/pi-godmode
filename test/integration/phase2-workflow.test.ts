import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPrimaryWorkflowController, WorkflowSchema } from "../../src/tools.ts";
import { renderAssignment, validateDelegation } from "../../src/faculties.ts";
import { appendWorkflowSnapshot, reconstructActiveSnapshot } from "../../src/session-ledger.ts";
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

function controller(root: string) {
  const manager = SessionManager.create(root, join(root, "sessions"));
  let record: WorkflowRecord | undefined;
  const instance = createPrimaryWorkflowController({
    pi: { appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); } },
    getSessionManager: () => manager,
    getWorkflowRecord: () => record,
    setWorkflowRecord: (next) => { record = next; },
    cwd: () => root,
    now: () => "2026-09-04T01:00:00.000Z",
  });
  return { manager, instance, getRecord: () => record };
}

function specify(instance: ReturnType<typeof createPrimaryWorkflowController>, classification: "feature" | "bugfix" | "documentation/configuration") {
  return instance.execute({
    action: "specify",
    workItemId: `${classification}-1`,
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
