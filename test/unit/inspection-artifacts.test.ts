import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  captureInspectionArtifacts,
  cleanupInspectionArtifacts,
  cleanupSupersededInspection,
  verifyInspectionArtifacts,
  scavengeInspectionArtifacts,
} from "../../src/inspection-artifacts.ts";
import type { PrimaryInspection } from "../../src/types.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "godmode-artifact-test-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Godmode Test"]);
  writeFileSync(join(root, "tracked.txt"), "base\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  return root;
}

function inspection(captured: ReturnType<typeof captureInspectionArtifacts>): PrimaryInspection {
  return {
    id: "inspection-test",
    actor: "Primary",
    inspectedAt: captured.statusReference.createdAt,
    statusReference: captured.statusReference,
    completeDiffReference: captured.completeDiffReference,
    diffFingerprint: captured.fingerprint,
    materiallyChangedPaths: captured.changedPaths,
    outOfScopeChanges: [],
    independentChecks: [{ id: "check", command: "npm test", result: "passed", evidenceReference: "artifact:test" }],
    residualRisks: [],
  };
}

test("inspection capture includes tracked, staged, and untracked content and verifies exact checkout identity", () => {
  const root = checkout();
  try {
    writeFileSync(join(root, "tracked.txt"), "working-tree\n");
    writeFileSync(join(root, "staged.txt"), "staged\n");
    git(root, ["add", "staged.txt"]);
    writeFileSync(join(root, "untracked.txt"), "untracked payload\n");
    const captured = captureInspectionArtifacts(root, new Date("2026-09-04T00:00:00.000Z"));
    const record = inspection(captured);
    assert.deepEqual(new Set(captured.changedPaths), new Set(["tracked.txt", "staged.txt", "untracked.txt"]));
    assert.match(captured.completeDiff.toString("utf8"), /untracked payload/);
    assert.match(captured.completeDiff.toString("utf8"), /GODMODE UNTRACKED FILE/);
    assert.equal(verifyInspectionArtifacts(root, record, new Date("2026-09-04T00:01:00.000Z")), true);

    writeFileSync(captured.completeDiffReference.source, "tampered");
    assert.equal(verifyInspectionArtifacts(root, record, new Date("2026-09-04T00:01:00.000Z")), false);
    writeFileSync(join(root, "tracked.txt"), "checkout mutation\n");
    assert.equal(verifyInspectionArtifacts(root, record, new Date("2026-09-04T00:01:00.000Z")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspection capture rejects bounded path counts and symlink changed paths", () => {
  const root = checkout();
  try {
    for (let index = 0; index < 257; index += 1) writeFileSync(join(root, `untracked-${index}.txt`), "x");
    assert.throws(() => captureInspectionArtifacts(root), /count|bounded|limit/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const symlinkRoot = checkout();
  const outside = mkdtempSync(join(tmpdir(), "godmode-artifact-outside-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "outside\n");
    symlinkSync(join(outside, "secret.txt"), join(symlinkRoot, "link.txt"));
    assert.throws(() => captureInspectionArtifacts(symlinkRoot), /symlink|unsafe|escape/i);
  } finally {
    rmSync(symlinkRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("remediation invalidation cleans the superseded inspection before fresh inspection and acceptance", () => {
  const root = checkout();
  try {
    writeFileSync(join(root, "tracked.txt"), "changed\n");
    const captured = captureInspectionArtifacts(root, new Date("2026-09-04T00:00:00.000Z"));
    const previous = inspection(captured);
    assert.equal(existsSync(captured.artifactDirectory), true);
    cleanupSupersededInspection(previous, undefined);
    assert.equal(existsSync(captured.artifactDirectory), false);
    // Idempotent terminal cleanup must not recreate or fail on the directory.
    cleanupSupersededInspection(previous, undefined);
    assert.equal(existsSync(captured.artifactDirectory), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded stale detector leaves stale, symlink, and raced own-prefix directories untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "godmode-scavenge-root-"));
  const outside = mkdtempSync(join(tmpdir(), "godmode-scavenge-outside-"));
  try {
    const stale = join(root, "pi-godmode-inspection-stale");
    const fresh = join(root, "pi-godmode-inspection-fresh");
    const link = join(root, "pi-godmode-inspection-link");
    const raced = join(root, "pi-godmode-inspection-raced");
    mkdirSync(stale);
    mkdirSync(fresh);
    mkdirSync(raced);
    writeFileSync(join(stale, "artifact"), "stale");
    writeFileSync(join(raced, "artifact"), "raced");
    utimesSync(stale, new Date(0), new Date(0));
    utimesSync(raced, new Date(0), new Date(0));
    symlinkSync(outside, link);

    // The detector is intentionally read-only. This source assertion guards
    // the no-deletion contract in addition to the observable filesystem proof.
    const implementation = readFileSync(new URL("../../src/security-text.ts", import.meta.url), "utf8");
    assert.doesNotMatch(implementation, /\b(?:rmSync|rmdirSync|unlinkSync|renameSync)\s*\(/u);
    assert.equal(scavengeInspectionArtifacts({ tmpRoot: root, now: new Date("2026-09-04T00:00:00.000Z") }), 2);
    assert.equal(existsSync(join(stale, "artifact")), true);
    assert.equal(existsSync(join(raced, "artifact")), true);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(link), true);
    assert.equal(existsSync(outside), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("inspection artifacts expire at the terminal boundary and cleanup is safe", () => {
  const root = checkout();
  try {
    writeFileSync(join(root, "tracked.txt"), "changed\n");
    const captured = captureInspectionArtifacts(root, new Date("2026-09-04T00:00:00.000Z"));
    const record = inspection(captured);
    assert.equal(verifyInspectionArtifacts(root, record, new Date(captured.statusReference.expiresAt)), false);
    assert.equal(readFileSync(captured.statusReference.source).byteLength > 0, true);
    cleanupInspectionArtifacts(record);
    assert.equal(verifyInspectionArtifacts(root, record, new Date("2026-09-04T00:01:00.000Z")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
