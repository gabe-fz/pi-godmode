import assert from "node:assert/strict";
import { test } from "node:test";
import { deadlineGraceMs, extensionCapacityMs, hardDeadlineMs, launchBackstopMs, MAX_DEADLINE_GRACE_MS, MAX_DEADLINE_MS, MAX_SUPERVISOR_EXTENSION_MS } from "../../src/deadlines.ts";

test("deadline defaults preserve a soft timeout and finite hard/backstop bounds", () => {
  assert.equal(deadlineGraceMs(1_000), 1_000);
  assert.equal(deadlineGraceMs(900_000), MAX_DEADLINE_GRACE_MS);
  assert.equal(hardDeadlineMs(1_000), 2_000);
  assert.equal(launchBackstopMs(1_000), 2_000 + MAX_SUPERVISOR_EXTENSION_MS);
  assert(launchBackstopMs(900_000) > hardDeadlineMs(900_000));
  assert.equal(extensionCapacityMs(1_000), MAX_SUPERVISOR_EXTENSION_MS);
  assert.equal(hardDeadlineMs(MAX_DEADLINE_MS), MAX_DEADLINE_MS);
  assert.equal(launchBackstopMs(MAX_DEADLINE_MS), MAX_DEADLINE_MS);
  assert.equal(extensionCapacityMs(MAX_DEADLINE_MS), 0);
});
