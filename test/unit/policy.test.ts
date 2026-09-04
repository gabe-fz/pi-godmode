import assert from "node:assert/strict";
import { test } from "node:test";
import { mutationGuard } from "../../src/mutation-guard.ts";
import { boundedStatus, statusLine } from "../../src/status.ts";
import type { GodmodeSnapshot } from "../../src/types.ts";
import { applyRoadmapTransition, deriveChecklistView } from "../../src/workflow-state.ts";
import { workflowRecord } from "../fixtures/workflow.ts";

function snapshot(faculty: "eye" | "hand" | "scale", phase: "launching" | "running" | "attention" | "stopping" = "running"): GodmodeSnapshot {
  return { phase: "active", delegation: phase, activeRun: { runId: "r", faculty, agent: `godmode-${faculty}`, title: "t", assignment: "a", phase, startedAt: 1 } };
}

test("mutation guard blocks mutation and unknown tools while allowing narrow reads and documented web reads", () => {
  for (const tool of ["bash", "edit", "write", "apply_patch", "custom_mutator", "unknown_tool"]) assert(mutationGuard(tool, snapshot("hand"))?.block);
  for (const tool of ["read", "grep", "find", "ls", "godmode_control", "subagent_supervisor", "web_search", "fetch_content", "get_search_content"]) assert.equal(mutationGuard(tool, snapshot("hand")), undefined);
  assert.equal(mutationGuard("write", snapshot("eye")), undefined);
});

test("status rendering is bounded and covers stable footer states", () => {
  assert.equal(statusLine({ phase: "active", delegation: "idle" }), "GODMODE ● idle");
  assert.equal(statusLine(snapshot("eye")), "GODMODE ● Eye running");
  assert.equal(statusLine(snapshot("hand", "attention")), "GODMODE ● decision requested");
  assert.equal(statusLine({
    ...snapshot("hand"),
    activeRun: { ...snapshot("hand").activeRun!, deadline: { phase: "pending", softDeadlineAt: 1, hardDeadlineAt: 2, remainingMs: 0, hardRemainingMs: 1, checkpoint: "pending" } },
  }), "GODMODE ● Hand deadline pending");
  assert.equal(statusLine({ phase: "degraded", delegation: "idle", degradedReason: "x" }), "GODMODE ● degraded");
  const result = boundedStatus({ phase: "active", delegation: "idle", degradedReason: "x".repeat(5000) });
  assert.equal((result.degradedReason as string).length, 1024);
});

test("workflow footer is derived from canonical checklist state without hiding operational status", () => {
  const audit = { actor: "Primary" as const, timestamp: "2026-09-03T00:00:00.000Z", reason: "Controlled verification.", reference: "evidence:test" };
  const implemented = applyRoadmapTransition(workflowRecord(), "item-1", { ...audit, actor: "Hand", to: "implemented-unverified" });
  const verified = applyRoadmapTransition(implemented, "item-1", { ...audit, to: "verified" });
  const record = applyRoadmapTransition(verified, "item-2", { ...audit, to: "blocked" });
  const workflow = deriveChecklistView(record);
  const rendered = statusLine({ phase: "active", delegation: "idle" }, workflow);
  assert.equal(rendered, "GODMODE ● idle · FLOW draft 1/2 · blocked 1 · next classification");
  assert(Buffer.byteLength(rendered ?? "", "utf8") <= 256);
});

test("bounded status exposes deadline phase and timing without assignment details", () => {
  const result = boundedStatus({
    phase: "active",
    delegation: "running",
    activeRun: {
      ...snapshot("hand").activeRun!,
      deadline: {
        phase: "pending",
        softDeadlineAt: 1_000,
        hardDeadlineAt: 2_000,
        remainingMs: 0,
        hardRemainingMs: 1_000,
        checkpoint: "requested",
        checkpointRequestedAt: 1_000,
      },
    },
  });
  assert.deepEqual((result.active as any).deadline, {
    phase: "pending",
    softDeadlineAt: 1_000,
    hardDeadlineAt: 2_000,
    remainingMs: 0,
    hardRemainingMs: 1_000,
    checkpoint: "requested",
    checkpointRequestedAt: 1_000,
  });
  assert.equal((result.active as any).assignment, undefined);
});
