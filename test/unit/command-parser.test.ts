import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGodmodeCommand } from "../../src/command-parser.ts";

test("doctor command parser has an exact non-toggling grammar", () => {
  assert.equal(parseGodmodeCommand(""), "toggle");
  assert.equal(parseGodmodeCommand("   "), "toggle");
  assert.equal(parseGodmodeCommand("doctor"), "doctor");
  assert.equal(parseGodmodeCommand("doctor --apply"), "apply-preview");
  assert.deepEqual(parseGodmodeCommand("doctor --apply --confirm token-123"), { action: "apply-confirm", token: "token-123" });
  assert.deepEqual(parseGodmodeCommand("doctor --apply --recover token-123"), { action: "apply-recover", token: "token-123" });
  assert.deepEqual(parseGodmodeCommand("doctor --apply --replace docs/GODMODE_WORKFLOW.md"), { action: "apply-replacement-preview", path: "docs/GODMODE_WORKFLOW.md" });
  for (const value of ["doctor --bad", "unknown", "toggle", "doctor extra", "--apply", "doctor --confirm token-123", "doctor --apply --yes", "doctor --apply --force", "doctor --apply --replace *", "doctor --apply --confirm token extra", "doctor --apply --confirm"]) {
    assert.equal(parseGodmodeCommand(value), "invalid", value);
  }
});
