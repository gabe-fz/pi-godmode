import assert from "node:assert/strict";
import { fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readSync as fsReadSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DOCTOR_MAX_AGGREGATE_READ_BYTES, DOCTOR_MAX_FILE_BYTES, DOCTOR_MAX_REPORT_BYTES, DOCTOR_MAX_SCANNED_ENTRIES, runDoctor } from "../../src/doctor.ts";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "godmode-doctor-unit-"));
}

test("doctor is deterministic, classifies passive surfaces, and proposes without writing", () => {
  const root = tempProject();
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.js", postinstall: "touch trap" }, dependencies: { express: "1" } }));
    writeFileSync(join(root, "README.md"), "A browser flow and controlled API request are documented here.\n");
    writeFileSync(join(root, "src", "index.ts"), "export const route = (req: unknown) => req;\n");
    writeFileSync(join(root, "tests", "route.test.ts"), "test('route', () => {});\n");
    const before = readdirSync(root, { withFileTypes: true }).map((entry) => entry.name).sort();
    const first = runDoctor(root);
    const second = runDoctor(root);
    assert.deepEqual(first, second);
    assert.equal(first.readOnly, true);
    assert.equal(first.applyAvailable, false);
    assert.match(first.rendered, /available only through explicit preview and confirmation/);
    assert(first.surfaces.some((surface) => surface.surface === "browser-ui"));
    assert(first.surfaces.some((surface) => surface.surface === "api"));
    assert(first.testCandidates.some((candidate) => candidate.path === "tests/route.test.ts"));
    assert(first.commands.every((candidate) => candidate.requiresExplicitApproval));
    assert(first.safetyFindings.some((finding) => finding.category === "lifecycle-script"));
    assert(first.proposals.some((proposal) => proposal.path === ".godmode/validation-profile.json"));
    assert(first.proposals.some((proposal) => proposal.path === "docs/GODMODE_WORKFLOW.md"));
    assert(first.proposals.every((proposal) => proposal.path !== "PROJECT_MEMORY.md"));
    assert.deepEqual(readdirSync(root, { withFileTypes: true }).map((entry) => entry.name).sort(), before);
    assert(Buffer.byteLength(first.rendered, "utf8") <= DOCTOR_MAX_REPORT_BYTES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor bounds broad/deep/oversize inputs and never follows symlink escapes", () => {
  const root = tempProject();
  const outside = tempProject();
  try {
    writeFileSync(join(outside, "outside.ts"), "export const outside = true;\n");
    mkdirSync(join(root, "src"));
    for (let index = 0; index < DOCTOR_MAX_SCANNED_ENTRIES + 30; index += 1) writeFileSync(join(root, `z-entry-${index}.txt`), "x");
    writeFileSync(join(root, "src", "large.ts"), "x".repeat(DOCTOR_MAX_FILE_BYTES + 1));
    symlinkSync(join(outside, "outside.ts"), join(root, "src", "escape.ts"));
    symlinkSync(outside, join(root, "src", "escape-directory"));
    const report = runDoctor(root);
    assert(report.limits.scannedEntries <= DOCTOR_MAX_SCANNED_ENTRIES);
    assert(report.limits.truncated);
    assert(report.safetyFindings.some((finding) => finding.category === "symlink"));
    assert(report.safetyFindings.some((finding) => finding.category === "oversize-file"));
    assert.equal(report.rendered.includes("outside.ts"), false);
    assert.equal(readFileSync(join(outside, "outside.ts"), "utf8"), "export const outside = true;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("doctor redacts secret-like paths/content and marks active checkout race", () => {
  const root = tempProject();
  try {
    writeFileSync(join(root, ".env.production"), "TOKEN=do-not-report\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { check: "echo TOKEN=do-not-report" } }));
    const report = runDoctor(root, { activeFaculty: "hand" });
    assert.equal(report.rendered.includes("do-not-report"), false);
    assert.equal(report.rendered.includes(".env.production"), false);
    assert(report.safetyFindings.some((finding) => finding.category === "secret-like-file"));
    const race = report.safetyFindings.find((finding) => finding.category === "checkout-race-active-faculty");
    assert.equal(race?.basis, "inferred");
    assert.equal(race?.confidence, "medium");
    assert(report.commands.every((command) => !command.command.includes("do-not-report")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor charges raced read bytes before every post-read identity failure", () => {
  const root = tempProject();
  try {
    const source = join(root, "src");
    mkdirSync(source);
    for (let index = 0; index < 40; index += 1) {
      writeFileSync(join(source, `raced-${index}.ts`), "x".repeat(64 * 1024));
    }
    let fstatCalls = 0;
    let readBytes = 0;
    const report = runDoctor(root, {
      fs: {
        fstatSync(fd) {
          const stat = fstatSync(fd);
          fstatCalls += 1;
          // Every file's second fstat is the post-read check. Make that
          // identity check fail while leaving the opened identity intact.
          if (fstatCalls % 2 === 0) {
            const changed = Object.create(stat) as typeof stat;
            changed.size = stat.size + 1;
            return changed;
          }
          return stat;
        },
        readSync(fd, buffer, offset, length, position) {
          // Read through the real descriptor while counting the bytes the
          // doctor actually requested; this seam performs no project writes.
          const result = fsReadSync(fd, buffer, offset, length, position);
          readBytes += result;
          return result;
        },
      },
    });
    assert(readBytes <= DOCTOR_MAX_AGGREGATE_READ_BYTES);
    assert(report.limits.aggregateReadBytes <= DOCTOR_MAX_AGGREGATE_READ_BYTES);
    assert(report.safetyFindings.some((finding) => finding.category === "read-race"));
    assert(report.safetyFindings.some((finding) => finding.category === "aggregate-read-limit"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor bounds complete report serialization and rendered output under high cardinality", () => {
  const root = tempProject();
  try {
    const scripts: Record<string, string> = {};
    for (let index = 0; index < 64; index += 1) scripts[`check-${index}`] = `echo ${"x".repeat(1_000)}-${index}`;
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
    const first = runDoctor(root);
    const second = runDoctor(root);
    assert(Buffer.byteLength(JSON.stringify(first), "utf8") <= DOCTOR_MAX_REPORT_BYTES);
    assert(Buffer.byteLength(first.rendered, "utf8") <= DOCTOR_MAX_REPORT_BYTES);
    assert.doesNotThrow(() => JSON.parse(first.rendered));
    assert.deepEqual(first, second);
    assert(first.limits.truncationReasons.includes("report-bytes"));
    assert(first.summary);
    assert.equal(first.summary.commands, 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
