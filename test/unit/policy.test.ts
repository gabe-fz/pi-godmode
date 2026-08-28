import assert from "node:assert/strict";
import { test } from "node:test";
import { mutationGuard } from "../../src/mutation-guard.ts";
import { boundedStatus, statusLine } from "../../src/status.ts";
import type { GodmodeSnapshot } from "../../src/types.ts";

function snapshot(faculty: "eye" | "hand" | "scale", phase: "launching" | "running" | "attention" | "stopping" = "running"): GodmodeSnapshot {
  return { phase: "active", delegation: phase, activeRun: { runId: "r", faculty, agent: `godmode-${faculty}`, title: "t", assignment: "a", phase, startedAt: 1 } };
}

test("mutation guard blocks every non-narrow Primary tool only while Hand owns checkout", () => {
  for (const tool of ["bash", "edit", "write", "apply_patch", "custom_mutator", "web_search"]) assert(mutationGuard(tool, snapshot("hand"))?.block);
  for (const tool of ["read", "grep", "find", "ls", "godmode_control", "subagent_supervisor"]) assert.equal(mutationGuard(tool, snapshot("hand")), undefined);
  assert.equal(mutationGuard("write", snapshot("eye")), undefined);
});

test("status rendering is bounded and covers stable footer states", () => {
  assert.equal(statusLine({ phase: "active", delegation: "idle" }), "GODMODE ● idle");
  assert.equal(statusLine(snapshot("eye")), "GODMODE ● Eye running");
  assert.equal(statusLine(snapshot("hand", "attention")), "GODMODE ● decision requested");
  assert.equal(statusLine({ phase: "degraded", delegation: "idle", degradedReason: "x" }), "GODMODE ● degraded");
  const result = boundedStatus({ phase: "active", delegation: "idle", degradedReason: "x".repeat(5000) });
  assert.equal((result.degradedReason as string).length, 1024);
});
