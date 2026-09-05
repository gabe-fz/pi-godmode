import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  LEDGER_CUSTOM_TYPE,
  appendWorkflowSnapshot,
  createLedgerSnapshot,
} from "../../src/session-ledger.ts";
import { workflowRecord } from "../fixtures/workflow.ts";

function ledgerEntry(id: string, data: unknown): SessionEntry {
  return {
    id,
    parentId: null,
    timestamp: "2026-09-05T00:00:00.000Z",
    type: "custom",
    customType: LEDGER_CUSTOM_TYPE,
    data,
  };
}

test("explicit mismatched operation identity cannot adopt a same-timestamp active-tail snapshot", () => {
  const record = workflowRecord();
  const createdAt = "2026-09-05T00:00:01.000Z";
  const persistedSnapshot = createLedgerSnapshot({
    sessionId: "operation-id-regression-session",
    workItemId: record.workItemId,
    generation: 1,
    predecessorEntryId: null,
    createdAt,
    record,
  });
  // This persisted entry predates the call, so there is no pending intent that
  // can authorize adopting it for the caller's explicit operation identity.
  const entries: SessionEntry[] = [ledgerEntry("entry-1", persistedSnapshot)];
  let writes = 0;
  const sessionManager = {
    getSessionId: () => "operation-id-regression-session",
    getBranch: () => [...entries],
    getLeafEntry: () => entries.at(-1),
  };
  const pi = {
    appendEntry(_customType: string, _data: unknown) {
      writes += 1;
    },
  };

  assert.throws(() => appendWorkflowSnapshot(
    pi,
    sessionManager,
    record,
    createdAt,
    undefined,
    "workflow-operation-v1-mismatched",
  ), /operation identity|append blocked/i);
  assert.equal(writes, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, "entry-1");
});
