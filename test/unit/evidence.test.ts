import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cleanupEvidenceArtifacts,
  EVIDENCE_MAX_FILE_BYTES,
  importEvidenceArtifacts,
  verifyEvidenceArtifact,
} from "../../src/evidence.ts";

test("bounded evidence importer copies clean explicit text and verifies tamper/expiry", () => {
  const root = mkdtempSync(join(tmpdir(), "godmode-evidence-unit-"));
  const input = join(root, "result.txt");
  writeFileSync(input, "status: passed\n");
  const imported = importEvidenceArtifacts([input], { cwd: root, now: new Date("2026-09-04T06:00:00.000Z"), retentionClass: "review" });
  const artifact = imported.artifacts[0]!;
  assert.equal(artifact.retentionClass, "review");
  assert.notEqual(artifact.source, input);
  assert.equal(readFileSync(artifact.source, "utf8"), "status: passed\n");
  assert.equal(verifyEvidenceArtifact(artifact, new Date("2026-09-04T06:01:00.000Z")), true);
  assert.equal(verifyEvidenceArtifact(artifact, new Date("2026-09-04T06:16:00.000Z")), false);
  writeFileSync(artifact.source, "tampered\n");
  assert.equal(verifyEvidenceArtifact(artifact, new Date("2026-09-04T06:01:00.000Z")), false);
  cleanupEvidenceArtifacts(imported.directory);
  cleanupEvidenceArtifacts(imported.directory);
  assert.equal(existsSync(imported.directory), false);
});

test("evidence importer rejects credentials, binary payloads, .env files, symlinks, and escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "godmode-evidence-unit-"));
  const secret = join(root, "secret.txt");
  writeFileSync(secret, "Authorization: Bearer abcdefghijklmnop\n");
  assert.throws(() => importEvidenceArtifacts([secret], { cwd: root }), /secret|credential|token/i);
  const binary = join(root, "binary.bin");
  writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
  assert.throws(() => importEvidenceArtifacts([binary], { cwd: root }), /NUL|binary/i);
  const env = join(root, ".env");
  writeFileSync(env, "TOKEN=value\n");
  assert.throws(() => importEvidenceArtifacts([env], { cwd: root }), /env|credential/i);
  const active = join(root, "active.html");
  writeFileSync(active, "<script>alert('unsafe')</script>\n");
  assert.throws(() => importEvidenceArtifacts([active], { cwd: root }), /active|content/i);
  const target = join(root, "target.txt");
  const link = join(root, "link.txt");
  writeFileSync(target, "safe\n");
  symlinkSync(target, link);
  assert.throws(() => importEvidenceArtifacts([link], { cwd: root }), /symlink|regular/i);
  // This directory is deliberately outside both the checkout root and the
  // automatically approved OS-temp root; this is a real root-escape check.
  const outside = mkdtempSync(join(process.cwd(), "..", "godmode-evidence-outside-"));
  const outsideFile = join(outside, "outside.txt");
  writeFileSync(outsideFile, "outside\n");
  try {
    assert.throws(() => importEvidenceArtifacts([outsideFile], { cwd: root }), /outside|approved root/i);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("evidence importer enforces file and aggregate limits", () => {
  const root = mkdtempSync(join(tmpdir(), "godmode-evidence-unit-"));
  const large = join(root, "large.txt");
  writeFileSync(large, "x".repeat(EVIDENCE_MAX_FILE_BYTES + 1));
  assert.throws(() => importEvidenceArtifacts([large], { cwd: root }), /size|bounded/i);
  const many: string[] = [];
  for (let index = 0; index < 65; index += 1) {
    const path = join(root, `item-${index}.txt`);
    writeFileSync(path, `${index}\n`);
    many.push(path);
  }
  assert.throws(() => importEvidenceArtifacts(many, { cwd: root }), /count|bounded/i);
  const small: string[] = [];
  mkdirSync(join(root, "aggregate"));
  for (let index = 0; index < 3; index += 1) {
    const path = join(root, "aggregate", `item-${index}.txt`);
    writeFileSync(path, `${index}-`.padEnd(100, "x"));
    small.push(path);
  }
  assert.throws(() => importEvidenceArtifacts(small, { cwd: root, maxTotalBytes: 200 }), /total|bounded/i);
});
