import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseGodmodeCommand } from "../../src/command-parser.ts";

test("FR-11 apply grammar requires preview and explicit tokenized confirmation", () => {
  assert.equal(parseGodmodeCommand("doctor --apply"), "apply-preview");
  assert.deepEqual(parseGodmodeCommand("doctor --apply --confirm token-123"), { action: "apply-confirm", token: "token-123" });
  assert.deepEqual(parseGodmodeCommand("doctor --apply --replace docs/GODMODE_WORKFLOW.md"), {
    action: "apply-replacement-preview",
    path: "docs/GODMODE_WORKFLOW.md",
  });
  assert.equal(parseGodmodeCommand("doctor --apply --yes"), "invalid");
});

test("FR-11 apply has a dedicated preview/conflict/confirmation implementation seam", () => {
  const url = new URL("../../src/doctor-apply.ts", import.meta.url);
  assert.equal(existsSync(url), true, "missing doctor apply implementation seam");
  const source = readFileSync(url, "utf8");
  assert.match(source, /createDoctorApplyPreview/);
  assert.match(source, /applyDoctorPreview/);
  assert.match(source, /O_EXCL|wx/);
  assert.match(source, /confirm|token/i);
  assert.match(source, /conflict|changed/i);
  assert.doesNotMatch(source, /force|--yes/i);
});

test("FR-11 apply APIs fail closed on trust and idle proofs", () => {
  const source = readFileSync(new URL("../../src/doctor-apply.ts", import.meta.url), "utf8");
  assert.match(source, /trusted !== true/);
  assert.match(source, /isIdle !== true && options\.idle !== true/);
  const extension = readFileSync(new URL("../../src/extension-helpers.ts", import.meta.url), "utf8");
  assert.match(extension, /isProjectTrusted\?\.\(\) === true/);
  assert.match(extension, /isIdle\?\.\(\) !== true/);
});

test("FR-11 replacement verification retains automatic rollback and bounded recovery", () => {
  const source = readFileSync(new URL("../../src/doctor-apply.ts", import.meta.url), "utf8");
  assert.match(source, /committed/);
  assert.match(source, /rollbackReplacement/);
  assert.match(source, /recoveryForFailedReplacement/);
  assert.match(source, /recoveryToken/);
});

test("FR-12 apply source is restricted to the two documented project paths", () => {
  const extension = readFileSync(new URL("../../src/extension-helpers.ts", import.meta.url), "utf8");
  assert.match(extension, /\.godmode\/validation-profile\.json/);
  assert.match(extension, /docs\/GODMODE_WORKFLOW\.md/);
  assert.doesNotMatch(extension, /PROJECT_MEMORY\.md[^\n]*(?:write|replace|delete|remove)/i);
});
