import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { FACULTY_PROMPTS, facultyDefinition, renderAssignment, validateDelegation } from "../../src/faculties.ts";
import { validConfig } from "../fixtures/config.ts";

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "godmode-faculties-"));
  mkdirSync(join(root, "src"));
  return root;
}

test("delegation normalizes arrays, requires Hand scope/checks, and renders standalone contract", () => {
  const cwd = checkout();
  const normalized = validateDelegation({
    faculty: "hand",
    title: " Implement feature ",
    task: "Add bounded behavior.",
    contextFiles: ["src", "src", "./src"],
    expectedPaths: [join(cwd, "src")],
    acceptanceChecks: ["npm test", "npm test"],
    constraints: ["No dependencies"],
  }, cwd);
  assert.deepEqual(normalized.contextFiles, ["src"]);
  assert.deepEqual(normalized.acceptanceChecks, ["npm test"]);
  const assignment = renderAssignment(normalized);
  for (const heading of ["Role and authority boundary", "Goal and approved behavior", "Starting context", "Expected mutation scope", "Constraints and non-authority rules", "Validation expectations", "Required handoff", "Decision escalation"]) assert.match(assignment, new RegExp(heading));
  assert.match(assignment, /contact_supervisor/);
  assert.throws(() => validateDelegation({ faculty: "hand", title: "x", task: "x", expectedPaths: [], acceptanceChecks: [] }, cwd), /expectedPaths/);
});

test("Eye and Scale reinterpret expected paths as read-only context", () => {
  const cwd = checkout();
  assert.throws(() => validateDelegation({ faculty: "eye", title: "Fix source", task: "Inspect it" }, cwd), /mutation-oriented/);
  const eye = validateDelegation({ faculty: "eye", title: "Inspect", task: "Inspect source", contextFiles: ["src"], expectedPaths: ["src", "./src"] }, cwd);
  assert.deepEqual(eye.contextFiles, ["src"]);
  assert.deepEqual(eye.expectedPaths, []);
  const scale = validateDelegation({ faculty: "scale", title: "Review", task: "Review behavior", expectedPaths: [join(cwd, "src"), "src"] }, cwd);
  assert.deepEqual(scale.contextFiles, ["src"]);
  assert.deepEqual(scale.expectedPaths, []);
  assert.doesNotThrow(() => validateDelegation({ faculty: "scale", title: "Review implementation", task: "Inspect actual source and report fix-now findings", constraints: ["Do not edit files"] }, cwd));
});

test("paths normalize in-checkout absolute paths and reject traversal or escaping symlinks", () => {
  const cwd = checkout();
  const outside = mkdtempSync(join(tmpdir(), "godmode-outside-"));
  symlinkSync(outside, join(cwd, "escape"));
  symlinkSync(join(cwd, "src"), join(outside, "into-checkout"));
  const base = { faculty: "eye" as const, title: "Inspect", task: "Inspect source" };
  const normalized = validateDelegation({ ...base, contextFiles: [join(cwd, "src")], expectedPaths: [join(cwd, "src")] }, cwd);
  assert.deepEqual(normalized.contextFiles, ["src"]);
  assert.deepEqual(normalized.expectedPaths, []);
  const inbound = validateDelegation({ ...base, contextFiles: [join(outside, "into-checkout")] }, cwd);
  assert.deepEqual(inbound.contextFiles, ["src"]);
  assert.throws(() => validateDelegation({ ...base, contextFiles: ["../x"] }, cwd), /traversal/);
  assert.throws(() => validateDelegation({ ...base, contextFiles: [outside] }, cwd), /outside/);
  assert.throws(() => validateDelegation({ ...base, contextFiles: ["escape/file"] }, cwd), /symlink/);
  assert.throws(() => validateDelegation({ ...base, contextFiles: [join(cwd, "escape/file")] }, cwd), /symlink/);
  assert.throws(() => validateDelegation({ ...base, contextFiles: ["escape/../src"] }, cwd), /traversal/);
  assert.throws(() => validateDelegation({ ...base, contextFiles: [`${cwd}${sep}escape${sep}..${sep}src`] }, cwd), /traversal/);
});

test("faculty definitions pin exact prompts, tools, models, extensions, and mutation role", () => {
  const config = validConfig();
  const hand = facultyDefinition("hand", config.faculties.hand);
  assert.equal(hand.model, "openai-codex/gpt-5.6-luna");
  assert.equal(hand.thinking, "xhigh");
  assert.deepEqual(hand.tools, ["read", "grep", "find", "ls", "bash", "edit", "write"]);
  assert.deepEqual(hand.extensions, []);
  assert.deepEqual(hand.subagentOnlyExtensions, []);
  assert.deepEqual(hand.mutationTools, ["bash", "edit", "write"]);
  assert.match(FACULTY_PROMPTS.hand, /sole mutation-capable/);
  assert.match(FACULTY_PROMPTS.eye, /read-only/);
  assert.match(FACULTY_PROMPTS.scale, /never accept/);
});
