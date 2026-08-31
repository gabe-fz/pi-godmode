import assert from "node:assert/strict";
import { test } from "node:test";
import { ASYNC_COMPLETE_EVENT, completionState, RPC_REQUEST_EVENT, SubagentsClient, type EventBus } from "../../src/subagents-client.ts";

class Bus implements EventBus {
  handlers = new Map<string, Set<(value: unknown) => void>>();
  requests: Record<string, any>[] = [];
  responder?: (request: Record<string, any>) => unknown;
  on(event: string, handler: (value: unknown) => void) { const set = this.handlers.get(event) ?? new Set(); set.add(handler); this.handlers.set(event, set); return () => set.delete(handler); }
  emit(event: string, value: unknown) {
    if (event === RPC_REQUEST_EVENT) {
      const request = value as Record<string, any>; this.requests.push(request);
      const response = this.responder?.(request);
      if (response !== undefined) queueMicrotask(() => this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: response }));
    }
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }
}

const ping = {
  version: 1,
  methods: ["ping", "spawn", "status", "steer", "stop"],
  capabilities: { asyncSpawn: true, nonRecoveringSteer: true, stop: true, status: true, fleetStatus: { version: 1 }, processTerminalProof: { version: 1 } },
  events: { asyncComplete: ASYNC_COMPLETE_EVENT },
};

test("RPC adapter checks capabilities and emits constrained exact spawn envelope", async () => {
  const bus = new Bus();
  bus.responder = (request) => request.method === "ping" ? ping : { details: { runId: "run-1" } };
  const client = new SubagentsClient(bus, { idFactory: (() => { let i = 0; return () => `id-${++i}`; })() });
  await client.ping();
  const receipt = await client.spawn({ agent: "godmode-hand", task: "bounded", cwd: "/repo", config: { provider: "p", model: "m", thinking: "medium", timeoutMs: 1234 } });
  assert.equal(receipt.runId, "run-1");
  const params = bus.requests[1]!.params;
  assert.deepEqual(params, { agent: "godmode-hand", task: "bounded", cwd: "/repo", context: "fresh", async: true, timeoutMs: 1234, model: "p/m:medium", artifacts: true });
  for (const forbidden of ["workflowScript", "workflowScriptPath", "worktree", "schedule", "tools"]) assert(!Object.hasOwn(params, forbidden));
});

test("RPC adapter fails capability detection and ambiguous status closed", async () => {
  const bus = new Bus();
  bus.responder = (request) => request.method === "ping" ? { ...ping, capabilities: { ...ping.capabilities, nonRecoveringSteer: false } } : { asyncSnapshot: { runs: [] } };
  const client = new SubagentsClient(bus);
  await assert.rejects(client.ping(), /non-recovering/);
  await assert.rejects(client.status("missing"), /ambiguous/);
});

test("status and completion parsing retain exact lifecycle meaning", async () => {
  const bus = new Bus();
  bus.responder = () => ({ asyncSnapshot: { runs: [{ id: "r", state: "running", activity: { state: "needs_attention" } }] } });
  assert.equal((await new SubagentsClient(bus).status("r")).state, "needs_attention");
  assert.equal(completionState({ runId: "r", results: [{ success: false }] }), "failed");
  assert.equal(completionState({ runId: "r", stopped: true }), "stopped");
  assert.equal(completionState({ runId: "r", state: "paused" }), "needs_attention");
  assert.equal(completionState({ runId: "r", state: "timed_out" }), "timed_out");
  assert.equal(completionState({ runId: "r", timedOut: true }), "timed_out");
  assert.equal(completionState({ runId: "r", results: [{ success: true }] }), "complete");
});

test("steer supports a queued checkpoint without changing the default mode", async () => {
  const bus = new Bus();
  bus.responder = () => ({ deliveryStatus: "queued" });
  const client = new SubagentsClient(bus);
  await client.steer("r", "checkpoint", "follow_up");
  assert.deepEqual(bus.requests[0]?.params, { id: "r", message: "checkpoint", mode: "follow_up" });
});
