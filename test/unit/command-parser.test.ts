import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGodmodeCommand } from "../../src/command-parser.ts";

test("doctor command parser has an exact non-toggling grammar", () => {
  assert.equal(parseGodmodeCommand(""), "toggle");
  assert.equal(parseGodmodeCommand("   "), "toggle");
  assert.equal(parseGodmodeCommand("doctor"), "doctor");
  assert.equal(parseGodmodeCommand("doctor --apply"), "apply-unavailable");
  for (const value of ["doctor --bad", "unknown", "toggle", "doctor extra", "--apply"]) {
    assert.equal(parseGodmodeCommand(value), "invalid", value);
  }
});
