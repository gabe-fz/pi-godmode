import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureInspectionArtifacts } from "../../src/inspection-artifacts.ts";
import { DoctorApplyManager } from "../../src/doctor-apply.ts";
import { runDoctor } from "../../src/doctor.ts";

const rootFile = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("FR-13 published package includes every focused document linked by README and SPEC", () => {
  const pkg = JSON.parse(rootFile("package.json")) as { files?: string[] };
  assert(pkg.files?.includes("docs/"), "published package omits focused docs");
});

test("FR-12 secret-bearing checkout diffs never become Scale inspection artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "godmode-phase7-secret-diff-"));
  try {
    // A real git checkout with one committed file and one secret-bearing change.
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Godmode Test"], { cwd: root });
    writeFileSync(join(root, "safe.txt"), "safe\n");
    execFileSync("git", ["add", "safe.txt"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: root });
    writeFileSync(join(root, "secret.txt"), "Authorization: Bearer abcdefghijklmnop\n");
    assert.throws(() => captureInspectionArtifacts(root), /secret|credential|token|redact|unsafe/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FR-12 direct effectful apply requires affirmative no-active-faculty proof", () => {
  const root = mkdtempSync(join(tmpdir(), "godmode-phase7-apply-proof-"));
  try {
    const manager = new DoctorApplyManager();
    const preview = manager.createPreview(root, runDoctor(root));
    const result = manager.apply(root, preview.token, { trusted: true, isIdle: true });
    assert.equal(result.status, "denied");
    assert.match(result.rendered, /active|faculty|proof/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FR-9 accepted runtime path creates and references a completion capsule", () => {
  const tools = rootFile("src/tools.ts");
  assert.match(tools, /createCompletionCapsule/);
  assert.match(tools, /latestCapsuleReference/);
});

test("FR-13 focused docs carry durable requirement traceability without the temporary plan", () => {
  const workflow = rootFile("docs/WORKFLOW.md");
  for (const id of ["FR-1", "FR-2", "FR-3", "FR-4", "FR-5", "FR-6", "FR-7", "FR-8"]) assert.match(workflow, new RegExp(`\\b${id}\\b`));
  assert.match(rootFile("docs/STATE_AND_MEMORY.md"), /\bFR-9\b/);
  for (const id of ["FR-10", "FR-11", "FR-12"]) assert.match(rootFile("docs/DOCTOR.md"), new RegExp(`\\b${id}\\b`));
  assert.doesNotMatch(rootFile("README.md"), /IMPLEMENTATION_PLAN[.]md/);
});
