import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  LEDGER_CUSTOM_TYPE,
  appendForkWorkflowSnapshot,
  appendWorkflowSnapshot,
  captureForkSuccessorProof,
  reconstructActiveSnapshot,
} from "../../src/session-ledger.ts";
import type { LedgerRecoveryContext } from "../../src/types.ts";
import { workflowRecord } from "../fixtures/workflow.ts";

function persistedSession() {
  const root = mkdtempSync(join(tmpdir(), "godmode-ledger-"));
  const manager = SessionManager.create(root, join(root, "sessions"));
  appendWorkflowSnapshot(
    { appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); } },
    manager,
    workflowRecord(),
    "2026-09-03T00:00:00.000Z",
  );
  // Pi delays creating a session file until an assistant message exists.
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
  assert(file, "fixture must persist a session file");
  return { manager, file };
}

test("controlled reopen recovers the canonical ledger without injecting custom entries into LLM context", () => {
  const { file } = persistedSession();
  const reopened = SessionManager.open(file);
  const recovered = reconstructActiveSnapshot(reopened.getBranch(), reopened.getSessionId(), "work-1");
  assert.equal(recovered.status, "ok");
  assert.equal(reopened.getBranch().some((entry) => entry.type === "custom" && entry.customType === LEDGER_CUSTOM_TYPE), true);
  assert.equal(reopened.buildSessionContext().messages.length, 1);
  assert.equal(reopened.buildSessionContext().messages.some((message) => JSON.stringify(message).includes(LEDGER_CUSTOM_TYPE)), false);
});

test("a fork inherits stale state and becomes recoverable only after its current-session successor", () => {
  const { manager } = persistedSession();
  const parentLeaf = manager.getLeafEntry();
  const parentSessionId = manager.getSessionId();
  const parentSessionFile = manager.getSessionFile();
  assert(parentLeaf);
  assert(parentSessionFile);
  const forkFile = manager.createBranchedSession(parentLeaf.id);
  assert(forkFile, "fixture must create a persisted fork");
  const fork = SessionManager.open(forkFile);

  const inherited = reconstructActiveSnapshot(fork.getBranch(), fork.getSessionId(), "work-1");
  assert.equal(inherited.status, "blocked");

  const inheritedSeed = reconstructActiveSnapshot(fork.getBranch(), parentSessionId, "work-1");
  assert.equal(inheritedSeed.status, "ok");
  if (inheritedSeed.status !== "ok") return;
  const proof = captureForkSuccessorProof({
    reason: "fork",
    previousSessionFile: parentSessionFile,
    parentSessionFile: fork.getHeader()?.parentSession,
    sessionId: fork.getSessionId(),
    workItemId: "work-1",
    inheritedEntryId: inheritedSeed.entryId,
    inheritedSnapshot: inheritedSeed.snapshot,
  });
  assert(proof, "trusted lifecycle proof must be issued for a real fork");
  appendForkWorkflowSnapshot(
    { appendEntry: (customType: string, data: unknown) => { fork.appendCustomEntry(customType, data); } },
    fork,
    workflowRecord(),
    "2026-09-03T00:01:00.000Z",
    proof,
  );
  const reopenedFork = SessionManager.open(forkFile);
  const recoveryContext: LedgerRecoveryContext = {
    sessionId: reopenedFork.getHeader()?.id,
    parentSessionFile: reopenedFork.getHeader()?.parentSession,
  };
  const recovered = reconstructActiveSnapshot(
    reopenedFork.getBranch(),
    reopenedFork.getSessionId(),
    "work-1",
    recoveryContext,
  );
  assert.equal(recovered.status, "ok");
  if (recovered.status === "ok") {
    assert.equal(recovered.snapshot.sessionId, reopenedFork.getSessionId());
    assert.equal(recovered.snapshot.generation, 1);
    assert(recovered.snapshot.forkOrigin);
  }
  assert.equal(reopenedFork.buildSessionContext().messages.some((message) => JSON.stringify(message).includes(LEDGER_CUSTOM_TYPE)), false);
});
