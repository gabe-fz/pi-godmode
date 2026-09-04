import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  LEDGER_CUSTOM_TYPE,
  appendWorkflowSnapshot,
  reconstructActiveSnapshot,
} from "../../src/session-ledger.ts";
import {
  registerWorkflowLifecycle,
  type WorkflowLifecycleOptions,
} from "../../src/workflow-lifecycle.ts";
import { workflowRecord } from "../fixtures/workflow.ts";

function context(sessionManager: SessionManager): ExtensionContext {
  return {
    sessionManager,
    hasUI: true,
  } as unknown as ExtensionContext;
}

function persistedParent(): { manager: SessionManager; file: string; leaf: SessionEntry } {
  const root = mkdtempSync(join(tmpdir(), "godmode-lifecycle-"));
  const manager = SessionManager.create(root, join(root, "sessions"));
  appendWorkflowSnapshot(
    { appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); } },
    manager,
    workflowRecord(),
    "2026-09-03T00:00:00.000Z",
  );
  manager.appendMessage({
    role: "assistant",
    content: [],
    timestamp: Date.now(),
    api: "fixture",
    provider: "fixture",
    model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
  });
  const file = manager.getSessionFile();
  const leaf = manager.getLeafEntry();
  assert(file);
  assert(leaf);
  return { manager, file, leaf };
}

test("registered workflow lifecycle restores, forks, blocks malformed lineage, refreshes, and cleans up", () => {
  const { manager, file, leaf } = persistedParent();
  const registered = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const appends: Array<{ customType: string; data: unknown }> = [];
  const views: unknown[] = [];
  const blocked: Array<string | undefined> = [];
  const refreshes: ExtensionContext[] = [];
  const pi = {
    appendEntry(customType: string, data: unknown) {
      appends.push({ customType, data });
      activeManager?.appendCustomEntry(customType, data);
    },
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      registered.set(event, handler);
    },
  };
  let activeManager: SessionManager | undefined = manager;
  const options: Omit<WorkflowLifecycleOptions, "pi"> = {
    setWorkflowView(view) { views.push(view); },
    setWorkflowBlockedReason(reason) { blocked.push(reason); },
    refresh(ctx) { refreshes.push(ctx); },
    now: () => "2026-09-03T00:01:00.000Z",
  };
  registerWorkflowLifecycle(pi as never, options);

  for (const event of ["session_start", "session_before_fork", "session_tree", "session_shutdown"]) {
    assert.equal(registered.has(event), true, `missing registered handler: ${event}`);
  }

  const parentContext = context(manager);
  registered.get("session_start")?.({ type: "session_start", reason: "startup" }, parentContext);
  assert.equal((views.at(-1) as { workItemId: string } | undefined)?.workItemId, "work-1");
  assert.equal(refreshes.length > 0, true);
  const beforeFork = registered.get("session_before_fork")?.({ type: "session_before_fork", entryId: leaf.id, position: "at" }, parentContext);
  assert.equal(beforeFork, undefined);

  const forkFile = manager.createBranchedSession(leaf.id);
  assert(forkFile);
  const fork = SessionManager.open(forkFile);
  activeManager = fork;
  const forkContext = context(fork);
  registered.get("session_start")?.({
    type: "session_start",
    reason: "fork",
    previousSessionFile: file,
  }, forkContext);

  const successor = fork.getLeafEntry();
  assert(successor);
  assert.equal(successor.type, "custom");
  if (successor.type === "custom") assert.equal(successor.customType, LEDGER_CUSTOM_TYPE);
  assert.equal(appends.length, 1);
  const recovered = reconstructActiveSnapshot(fork.getBranch(), fork.getSessionId(), "work-1", {
    sessionId: fork.getHeader()?.id,
    parentSessionFile: fork.getHeader()?.parentSession,
  });
  assert.equal(recovered.status, "ok");
  assert.equal(fork.buildSessionContext().messages.some((message) => JSON.stringify(message).includes(LEDGER_CUSTOM_TYPE)), false);
  assert.equal(refreshes.length >= 2, true, "lifecycle changes refresh the footer");

  const malformedEntries: SessionEntry[] = [
    {
      id: "ledger",
      parentId: null,
      timestamp: "2026-09-03T00:00:00.000Z",
      type: "custom",
      customType: LEDGER_CUSTOM_TYPE,
      data: (manager.getBranch().find((entry) => entry.type === "custom" && entry.customType === LEDGER_CUSTOM_TYPE) as Extract<SessionEntry, { type: "custom" }>).data,
    },
    {
      id: "orphan",
      parentId: "missing-parent",
      timestamp: "2026-09-03T00:00:00.000Z",
      type: "custom",
      customType: "unrelated",
      data: null,
    },
  ];
  const malformedManager = {
    getSessionId: () => "malformed-session",
    getBranch: () => malformedEntries,
    getLeafEntry: () => malformedEntries.at(-1),
    getHeader: () => ({ parentSession: file }),
  } as unknown as SessionManager;
  registered.get("session_tree")?.({ type: "session_tree" }, context(malformedManager));
  assert.match(blocked.at(-1) ?? "", /lineage|branch|root|blocked/i);
  assert.equal(refreshes.length >= 3, true);

  registered.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, forkContext);
  assert.equal(views.at(-1), undefined);
  assert.equal(blocked.at(-1), undefined);
});
