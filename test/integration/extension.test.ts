import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeGodmodeSession, toggleGodmodeTui } from "../../src/extension-helpers.ts";
import { registerWorkflowLifecycle } from "../../src/workflow-lifecycle.ts";
import type { GodmodeSnapshot } from "../../src/types.ts";

function snapshot(phase: GodmodeSnapshot["phase"], active = false): GodmodeSnapshot {
  return {
    phase,
    delegation: active ? "running" : "idle",
    ...(active ? {
      activeRun: {
        runId: "run-1",
        faculty: "hand",
        agent: "godmode-hand",
        title: "Implement",
        assignment: "Implement the bounded change.",
        phase: "running",
        startedAt: 1,
      },
    } : {}),
  };
}

test("workflow lifecycle registration binds every session boundary behaviorally", () => {
  const events: string[] = [];
  const pi = {
    appendEntry() {},
    on(event: string) { events.push(event); },
  };
  registerWorkflowLifecycle(pi as never, {
    setWorkflowView() {},
    setWorkflowBlockedReason() {},
    refresh() {},
  });
  assert.deepEqual(events, ["session_start", "session_before_fork", "session_tree", "session_shutdown"]);
});

test("session initialization enables Godmode by default after establishing the baseline", async () => {
  const events: string[] = [];
  let phase: GodmodeSnapshot["phase"] = "off";
  let activeTools = ["read", "subagent", "subagent_wait", "godmode_delegate", "godmode_control"];
  const mode = {
    get snapshot() { return snapshot(phase); },
    async enable() { events.push("enable"); phase = "active"; },
  };
  const pi = {
    getActiveTools() { events.push("get-tools"); return activeTools; },
    setActiveTools(names: string[]) { events.push("set-tools"); activeTools = names; },
  };
  const ctx = {
    hasUI: true,
    ui: {
      setStatus(key: string, value: string | undefined) { events.push(`status:${key}:${value ?? "clear"}`); },
      notify() { throw new Error("startup should not notify after successful enable"); },
    },
  };

  await initializeGodmodeSession(mode, pi, ctx);

  assert.equal(phase, "active");
  assert.deepEqual(activeTools, ["read", "subagent", "subagent_wait"]);
  assert.deepEqual(events, ["get-tools", "set-tools", "status:godmode:clear", "enable"]);
});

test("session initialization establishes the baseline before default-on enable and reports startup failure", async () => {
  const events: string[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  let activeTools = ["read", "subagent", "subagent_wait", "godmode_delegate", "godmode_control"];
  const mode = {
    snapshot: snapshot("off"),
    async enable() {
      events.push("enable");
      throw new Error("configured model unavailable");
    },
  };
  const pi = {
    getActiveTools() {
      events.push("get-tools");
      return activeTools;
    },
    setActiveTools(names: string[]) {
      events.push("set-tools");
      activeTools = names;
    },
  };
  const ctx = {
    hasUI: true,
    ui: {
      setStatus(key: string, value: string | undefined) { events.push(`status:${key}:${value ?? "clear"}`); },
      notify(message: string, type?: "info" | "warning" | "error") { notifications.push({ message, type }); },
    },
  };

  await initializeGodmodeSession(mode, pi, ctx);

  assert.deepEqual(events.slice(0, 4), ["get-tools", "set-tools", "status:godmode:clear", "enable"]);
  assert.deepEqual(activeTools, ["read", "subagent", "subagent_wait"]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "error");
  assert.match(notifications[0]?.message ?? "", /startup enable failed/);
  assert.match(notifications[0]?.message ?? "", /remains off/);
  assert.match(notifications[0]?.message ?? "", /run \/godmode to retry/);
});

test("session initialization contains baseline host failures and reports them", async () => {
  const notifications: Array<{ message: string; type?: string }> = [];
  let enableCalled = false;
  const mode = {
    snapshot: snapshot("off"),
    async enable() { enableCalled = true; },
  };
  const pi = {
    getActiveTools(): string[] { throw new Error("active tools unavailable"); },
    setActiveTools() { throw new Error("not expected"); },
  };
  const ctx = {
    hasUI: true,
    ui: {
      setStatus() { throw new Error("not expected"); },
      notify(message: string, type?: "info" | "warning" | "error") { notifications.push({ message, type }); },
    },
  };

  await initializeGodmodeSession(mode, pi, ctx);

  assert.equal(enableCalled, false);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "error");
  assert.match(notifications[0]?.message ?? "", /active tools unavailable/);
});

test("session initialization still resolves when failure notification is unavailable", async () => {
  const mode = {
    snapshot: snapshot("off"),
    async enable() { throw new Error("not expected"); },
  };
  const pi = {
    getActiveTools(): string[] { throw new Error("active tools unavailable"); },
    setActiveTools() { throw new Error("not expected"); },
  };
  const ctx = {
    hasUI: true,
    ui: {
      setStatus() { throw new Error("not expected"); },
      notify() { throw new Error("UI unavailable"); },
    },
  };

  await initializeGodmodeSession(mode, pi, ctx);
});

test("TUI toggle directly enables without selection and disables an idle active mode", async () => {
  const events: string[] = [];
  const notifications: string[] = [];
  let current = snapshot("off");
  const mode = {
    get snapshot() { return current; },
    async enable() { events.push("enable"); current = snapshot("active"); },
    async disable() { events.push("disable"); current = snapshot("off"); },
  };
  const ctx = {
    hasUI: true,
    ui: {
      notify(message: string) { notifications.push(message); },
      select() { throw new Error("TUI toggle must not open a selector"); },
    },
    async waitForIdle() { events.push("idle"); },
  };

  await toggleGodmodeTui(mode, ctx);
  assert.deepEqual(events, ["idle", "enable"]);
  assert.equal(notifications[0], "Godmode enabled.");

  await toggleGodmodeTui(mode, ctx);
  assert.deepEqual(events, ["idle", "enable", "idle", "disable"]);
  assert.equal(notifications[1], "Godmode disabled.");
});

test("TUI toggle-off passes stopActive for active faculties, including degraded mode", async () => {
  const stopOptions: Array<{ stopActive?: boolean } | undefined> = [];
  const notifications: string[] = [];
  let current = snapshot("degraded", true);
  const mode = {
    get snapshot() { return current; },
    async enable() { throw new Error("not expected"); },
    async disable(options?: { stopActive?: boolean }) {
      stopOptions.push(options);
      current = snapshot("off");
    },
  };
  const ctx = {
    hasUI: true,
    ui: { notify(message: string) { notifications.push(message); } },
    async waitForIdle() {},
  };

  await toggleGodmodeTui(mode, ctx);

  assert.deepEqual(stopOptions, [{ stopActive: true }]);
  assert.equal(notifications[0], "Faculty stopped and Godmode disabled.");
});
