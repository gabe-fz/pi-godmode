import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GodmodeMode, type ModeDependencies } from "../../src/mode.ts";
import { ModelLease, type PiModel } from "../../src/model-lease.ts";
import { ASYNC_COMPLETE_EVENT, CONTROL_EVENT, RPC_REQUEST_EVENT, SubagentsClient, type EventBus } from "../../src/subagents-client.ts";
import { validConfig } from "../fixtures/config.ts";
import { workflowRecord } from "../fixtures/workflow.ts";
import { applyPhaseTransition } from "../../src/workflow-state.ts";

const PING = {
  version: 1,
  methods: ["ping", "spawn", "status", "steer", "stop"],
  capabilities: { asyncSpawn: true, nonRecoveringSteer: true, stop: true, status: true, fleetStatus: { version: 1 }, processTerminalProof: { version: 1 } },
  events: { asyncComplete: ASYNC_COMPLETE_EVENT },
};

class OwnerBus implements EventBus {
  handlers = new Map<string, Set<(value: unknown) => void>>();
  log: string[] = [];
  requests: Record<string, any>[] = [];
  runState: string = "running";
  holdSpawn = false;
  dropSpawn = false;
  pendingSpawn?: () => void;
  on(event: string, handler: (value: unknown) => void) { const set = this.handlers.get(event) ?? new Set(); set.add(handler); this.handlers.set(event, set); return () => set.delete(handler); }
  emit(event: string, value: unknown) {
    if (event === RPC_REQUEST_EVENT) {
      const request = value as Record<string, any>;
      this.requests.push(request);
      this.log.push(`rpc:${request.method}`);
      const reply = (data: unknown) => queueMicrotask(() => this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data }));
      if (request.method === "ping") reply(PING);
      if (request.method === "spawn") {
        const done = () => reply({ details: { runId: "run-1" } });
        if (this.dropSpawn) { /* simulate a lost reply after an uncertain launch */ }
        else if (this.holdSpawn) this.pendingSpawn = done;
        else done();
      }
      if (request.method === "status") reply({ asyncSnapshot: { runs: [{ id: "run-1", state: this.runState }] } });
      if (request.method === "steer") reply({ deliveryStatus: "delivered" });
      if (request.method === "stop") { this.runState = "stopped"; reply({ runId: "run-1", state: "stopping" }); }
    }
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }
}

function fixture(options: {
  preflightError?: Error;
  holdSpawn?: boolean;
  dropSpawn?: boolean;
  clientTimeoutMs?: number;
  facultyTimeoutMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  omitWorkflowPersistence?: boolean;
} = {}) {
  const bus = new OwnerBus();
  bus.holdSpawn = options.holdSpawn ?? false;
  bus.dropSpawn = options.dropSpawn ?? false;
  const log = bus.log;
  const old: PiModel = { provider: "old", id: "model" };
  const godmodeModel: PiModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
  let model = old;
  let thinking: "medium" | "high" = "high";
  const host = {
    findModel: (provider: string, id: string) => [old, godmodeModel].find((candidate) => candidate.provider === provider && candidate.id === id),
    isModelScoped: () => true,
    async setModel(next: PiModel) { log.push(`model:${next.provider}/${next.id}`); model = next; return true; },
    getModel: () => model,
    getThinkingLevel: () => thinking,
    setThinkingLevel(level: typeof thinking) { log.push(`thinking:${level}`); thinking = level; },
  };
  const cwd = mkdtempSync(join(tmpdir(), "godmode-mode-"));
  const client = new SubagentsClient(bus, { timeoutMs: options.clientTimeoutMs ?? 1000 });
  let handWorkflow = workflowRecord({
    classification: "documentation/configuration",
    requirementIds: ["FR-1"],
    expectedPaths: ["src.ts"],
    roadmap: [{ id: "item-1", requirementIds: ["FR-1"], title: "Document bounded behavior", status: "pending" }],
    acceptanceChecks: ["npm test"],
    authorityConstraints: ["Hand may change only expected paths."],
    phase: "tdd-waived",
    history: [{
      kind: "phase",
      workItemId: "work-1",
      from: "red-test-ready",
      to: "tdd-waived",
      actor: "Primary",
      timestamp: "2026-09-04T00:00:00.000Z",
      reason: "Documentation-only work has no executable seam.",
      reference: "decision:waiver-1",
    }],
    tddWaiver: {
      id: "waiver-1",
      item: "work-1",
      requirementIds: ["FR-1"],
      inapplicableSeam: "No executable seam applies to documentation.",
      reason: "Documentation only.",
      approver: "Primary",
      date: "2026-09-04",
      scope: ["src.ts"],
      compensatingCheck: "npm test",
    },
  });
  const dependencies: ModeDependencies = {
    client,
    modelLease: new ModelLease(),
    modelHost: host,
    loadConfig: async () => {
      const config = validConfig();
      if (options.facultyTimeoutMs !== undefined) config.faculties.eye.timeoutMs = options.facultyTimeoutMs;
      return config;
    },
    isTrusted: () => true,
    cwd: () => cwd,
    sessionId: () => "session-1",
    getWorkflowRecord: () => handWorkflow,
    ...(!options.omitWorkflowPersistence ? {
      persistWorkflowTransition: (to: Parameters<typeof applyPhaseTransition>[1]["to"], reason: string, reference: string) => {
        handWorkflow = applyPhaseTransition(handWorkflow, {
          to,
          actor: "Primary",
          timestamp: "2026-09-04T00:00:01.000Z",
          reason,
          reference,
        });
        return handWorkflow;
      },
    } : {}),
    validateFacultyModels: () => { log.push("models:validated"); },
    registerFaculties: () => {
      log.push("faculties:register");
      return ["eye", "hand", "scale"].map((name) => ({ dispose: () => log.push(`faculty:${name}:dispose`) }));
    },
    registerCeiling: () => { log.push("ceiling:register"); return { dispose: () => log.push("ceiling:dispose") }; },
    preflight: async () => { log.push("preflight"); if (options.preflightError) throw options.preflightError; },
    acquireTools: () => log.push("tools:acquire"),
    releaseTools: () => log.push("tools:release"),
    sleep: async () => {},
    ...(options.now ? { now: options.now } : {}),
    ...(options.setTimer ? { setTimer: options.setTimer } : {}),
    ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
    pollMs: 0,
    stopWaitMs: 1000,
  };
  return { mode: new GodmodeMode(dependencies), bus, log, model: () => model, thinking: () => thinking };
}

const eye = { faculty: "eye" as const, title: "Inspect", task: "Inspect source evidence" };
const hand = { faculty: "hand" as const, title: "Implement", task: "Implement bounded change", expectedPaths: ["src.ts"], acceptanceChecks: ["npm test"] };

test("Hand admission fails closed without trusted workflow lifecycle persistence", async () => {
  const f = fixture({ omitWorkflowPersistence: true });
  await f.mode.enable();
  await assert.rejects(f.mode.delegate(hand), /trusted workflow lifecycle persistence/i);
  assert.equal(f.mode.snapshot.delegation, "idle");
  assert.equal(f.bus.requests.some((request) => request.method === "spawn"), false);
});

test("transactional enable, single-slot launch, attention, steer, and exact completion", async () => {
  const f = fixture({ holdSpawn: true });
  await f.mode.enable();
  assert.equal(f.mode.snapshot.phase, "active");
  assert.equal(`${f.model().provider}/${f.model().id}`, "openai-codex/gpt-5.6-sol");
  const first = f.mode.delegate(eye);
  assert.equal(f.mode.snapshot.delegation, "launching");
  await assert.rejects(f.mode.delegate(hand), /Only one/);
  f.bus.pendingSpawn!();
  assert.equal((await first).runId, "run-1");
  f.bus.emit(CONTROL_EVENT, { runId: "run-1", to: "needs_attention", type: "needs_attention" });
  assert.equal(f.mode.snapshot.delegation, "attention");
  await f.mode.steer("Continue using the decided behavior");
  assert.equal(f.mode.snapshot.delegation, "running");
  f.bus.emit(ASYNC_COMPLETE_EVENT, { runId: "other", success: true });
  assert(f.mode.snapshot.activeRun);
  f.bus.emit(ASYNC_COMPLETE_EVENT, { runId: "run-1", success: true, results: [{ success: true }] });
  assert.equal(f.mode.snapshot.delegation, "idle");
  assert.equal(f.mode.snapshot.lastRun?.state, "complete");
  f.bus.emit(ASYNC_COMPLETE_EVENT, { runId: "run-1", success: false });
  assert.equal(f.mode.snapshot.lastRun?.state, "complete");
});

test("completion received before the spawn reply is replayed after run correlation", async () => {
  const f = fixture({ holdSpawn: true });
  await f.mode.enable();
  const launch = f.mode.delegate(eye);
  f.bus.emit(ASYNC_COMPLETE_EVENT, { runId: "run-1", success: true, results: [{ success: true }] });
  assert.equal(f.mode.snapshot.delegation, "launching");
  f.bus.pendingSpawn!();
  assert.equal((await launch).runId, "run-1");
  assert.equal(f.mode.snapshot.delegation, "idle");
  assert.equal(f.mode.snapshot.lastRun?.runId, "run-1");
  assert.equal(f.mode.snapshot.lastRun?.state, "complete");
});

test("soft deadline requests a post-tool checkpoint without stopping a healthy faculty", async () => {
  let clock = 0;
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const f = fixture({
    facultyTimeoutMs: 1_000,
    now: () => clock,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true; },
  });
  await f.mode.enable();
  await f.mode.delegate(eye);
  assert.equal(f.bus.requests.find((request) => request.method === "spawn")?.params.timeoutMs, 302_000);
  clock = 1_000;
  timers[0]!.callback();
  assert.equal(f.mode.snapshot.activeRun?.deadline?.phase, "pending");
  assert.equal(f.mode.snapshot.activeRun?.deadline?.checkpoint, "pending");
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(f.mode.snapshot.activeRun?.deadline?.checkpoint, "requested");
  const steer = f.bus.requests.find((request) => request.method === "steer");
  assert.equal(steer?.params.mode, "follow_up");
  assert.match(steer?.params.message ?? "", /checkpoint/i);
  assert.equal(f.mode.snapshot.activeRun?.phase, "running");
});

test("supervisor can grant one bounded deadline extension before the hard stop", async () => {
  let clock = 0;
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const f = fixture({
    facultyTimeoutMs: 1_000,
    now: () => clock,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true; },
  });
  await f.mode.enable();
  await f.mode.delegate(eye);
  clock = 1_000;
  timers[0]!.callback();
  await f.mode.extend(2_000);
  assert.equal(f.mode.snapshot.activeRun?.deadline?.phase, "extended");
  assert.equal(f.mode.snapshot.activeRun?.deadline?.extensionMs, 2_000);
  assert.equal(f.mode.snapshot.activeRun?.deadline?.hardDeadlineAt, 4_000);
  await assert.rejects(f.mode.extend(1_000), /Only one/);
  clock = 4_000;
  timers.at(-1)!.callback();
  assert.equal(f.mode.snapshot.activeRun?.deadline?.phase, "hard");
  assert.equal(f.mode.snapshot.activeRun?.phase, "stopping");
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert(f.log.includes("rpc:stop"));
});

test("extension is rejected when the immutable launch backstop has no remaining headroom", async () => {
  let clock = 0;
  const timers: Array<{ callback: () => void; ms: number }> = [];
  const f = fixture({
    facultyTimeoutMs: 2_147_482_647,
    now: () => clock,
    setTimer: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
    clearTimer: () => {},
  });
  await f.mode.enable();
  await f.mode.delegate(eye);
  assert.equal(f.bus.requests.find((request) => request.method === "spawn")?.params.timeoutMs, 2_147_483_647);
  clock = 2_147_482_647;
  timers[0]!.callback();
  await assert.rejects(f.mode.extend(1), /0ms reserved/);
  assert.equal(f.mode.snapshot.activeRun?.deadline?.hardDeadlineAt, 2_147_483_647);
});

test("finite hard deadline stops an unresolved faculty", async () => {
  let clock = 0;
  const timers: Array<{ callback: () => void; ms: number }> = [];
  const f = fixture({
    facultyTimeoutMs: 1_000,
    now: () => clock,
    setTimer: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
    clearTimer: () => {},
  });
  await f.mode.enable();
  await f.mode.delegate(eye);
  clock = 2_000;
  timers[1]!.callback();
  assert.equal(f.mode.snapshot.activeRun?.deadline?.phase, "hard");
  assert.equal(f.mode.snapshot.activeRun?.phase, "stopping");
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert(f.log.includes("rpc:stop"));
});

test("Hand stop-and-disable proves terminal state before ordered cleanup and restoration", async () => {
  const f = fixture();
  await f.mode.enable();
  await f.mode.delegate(hand);
  await f.mode.disable({ stopActive: true });
  assert.equal(f.mode.snapshot.phase, "off");
  assert.equal(`${f.model().provider}/${f.model().id}`, "old/model");
  assert.equal(f.thinking(), "high");
  const stop = f.log.indexOf("rpc:stop");
  const status = f.log.indexOf("rpc:status");
  const ceiling = f.log.indexOf("ceiling:dispose");
  const tools = f.log.indexOf("tools:release");
  const restore = f.log.lastIndexOf("model:old/model");
  assert(stop >= 0 && status > stop && ceiling > status && tools > ceiling && restore > tools);
});

test("enable rollback disposes partial resources and restores lease", async () => {
  const f = fixture({ preflightError: new Error("contract mismatch") });
  await assert.rejects(f.mode.enable(), /contract mismatch/);
  assert.equal(f.mode.snapshot.phase, "off");
  assert.equal(`${f.model().provider}/${f.model().id}`, "old/model");
  assert(f.log.includes("ceiling:dispose"));
  assert(f.log.includes("faculty:eye:dispose"));
  assert(!f.log.includes("tools:acquire"));
});

test("lost spawn correlation degrades and keeps the pre-reserved slot", async () => {
  const f = fixture({ dropSpawn: true, clientTimeoutMs: 5 });
  await f.mode.enable();
  await assert.rejects(f.mode.delegate(eye), /outcome is uncertain/);
  assert.equal(f.mode.snapshot.phase, "degraded");
  assert.equal(f.mode.snapshot.delegation, "launching");
  assert(f.mode.snapshot.activeRun);
});

test("ambiguous status degrades and keeps active slot reserved", async () => {
  const f = fixture();
  await f.mode.enable();
  await f.mode.delegate(eye);
  // Hide exact run from the public bounded status snapshot.
  f.bus.runState = "unknown";
  await assert.rejects(f.mode.status(), /unknown state/);
  assert.equal(f.mode.snapshot.phase, "degraded");
  assert(f.mode.snapshot.activeRun);
  await assert.rejects(f.mode.delegate(eye), /healthy active/);
});
