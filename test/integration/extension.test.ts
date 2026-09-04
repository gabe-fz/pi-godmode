import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeGodmodeSession, registerGodmodeCommand, toggleGodmodeTui } from "../../src/extension-helpers.ts";
import { registerWorkflowLifecycle } from "../../src/workflow-lifecycle.ts";
import { runDoctor } from "../../src/doctor.ts";
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

test("registered godmode handler routes every Phase 5 command without mutating mode state", async () => {
  const notifications: Array<{ message: string; type?: string }> = [];
  const outputs: string[] = [];
  const events: string[] = [];
  const registered: { name?: string; command?: { handler: (args: string, ctx: unknown) => Promise<void> } } = {};
  const current = snapshot("active", true);
  const mode = {
    get snapshot() { return current; },
    async enable() { events.push("enable"); },
    async disable() { events.push("disable"); },
  };
  const doctorCalls: Array<{ root: string; activeFaculty?: string }> = [];
  const pi = {
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      registered.name = name;
      registered.command = command;
    },
  };
  registerGodmodeCommand(pi as never, {
    mode: mode as never,
    runDoctor(root, options) {
      doctorCalls.push({ root, activeFaculty: options?.activeFaculty });
      return runDoctor(root, options);
    },
    output(message) { outputs.push(message); },
    toggleTui: async () => { events.push("toggle"); },
  });
  assert.equal(registered.name, "godmode");
  assert(registered.command);
  const handler = registered.command.handler;
  const context = (modeName: "tui" | "print", hasUI: boolean) => ({
    mode: modeName,
    cwd: process.cwd(),
    hasUI,
    ui: { notify(message: string, type?: "info" | "warning" | "error") { notifications.push({ message, type }); } },
    async waitForIdle() { events.push("wait"); },
  });

  // Invalid arguments emit usage only and never invoke doctor/toggle.
  await handler("doctor --bad", context("tui", true));
  assert.equal(notifications.at(-1)?.type, "warning");
  assert.match(notifications.at(-1)?.message ?? "", /^Usage:/);
  assert.equal(doctorCalls.length, 0);

  // A doctor call while a faculty is active only receives the race marker.
  await handler("doctor", context("tui", true));
  assert.equal(notifications.at(-1)?.type, "info");
  assert.equal(doctorCalls.at(-1)?.activeFaculty, "hand");
  assert.match(notifications.at(-1)?.message ?? "", /checkout-race-active-faculty/);
  assert.deepEqual(events, []);

  // Opposite host modes retain the same non-toggling behavior.
  const outputCount = outputs.length;
  await handler("doctor --bad", context("print", false));
  assert.equal(outputs.length, outputCount + 1);
  assert.match(outputs.at(-1) ?? "", /^Usage:/);
  await handler("doctor", context("print", false));
  assert.equal(JSON.parse(outputs.at(-1) ?? "{}").readOnly, true);
  assert.equal(doctorCalls.at(-1)?.activeFaculty, "hand");

  // --apply remains the same read-only, unavailable report in both hosts.
  await handler("doctor --apply", context("print", false));
  const appliedOutput = outputs.at(-1) ?? "";
  assert.equal(JSON.parse(appliedOutput).readOnly, true);
  assert.equal(JSON.parse(appliedOutput).applyAvailable, false);
  await handler("doctor --apply", context("tui", true));
  assert.equal(notifications.at(-1)?.type, "info");
  assert.equal(JSON.parse(notifications.at(-1)?.message ?? "{}").readOnly, true);
  assert.equal(JSON.parse(notifications.at(-1)?.message ?? "{}").applyAvailable, false);
  assert.deepEqual(events, []);

  // Non-TUI bare command uses the unchanged bounded status path.
  await handler("", context("print", false));
  assert.deepEqual(JSON.parse(outputs.at(-1) ?? "{}"), {
    mode: "active", delegation: "running",
    active: { runId: "run-1", faculty: "hand", agent: "godmode-hand", state: "running", title: "Implement" },
  });

  // Bare TUI delegates only to the existing toggle path.
  await handler("", context("tui", true));
  assert.deepEqual(events, ["toggle"]);
  assert.equal((events as readonly string[]).includes("wait"), false);
  assert.equal((events as readonly string[]).includes("enable"), false);
  assert.equal((events as readonly string[]).includes("disable"), false);
});
