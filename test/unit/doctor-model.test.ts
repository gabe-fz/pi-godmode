import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DOCTOR_MAX_REPORT_BYTES, runDoctor } from "../../src/doctor.ts";
import { assessDoctorModel, projectDoctorReport } from "../../src/doctor-model.ts";

test("model doctor projects a real checkout without absolute identity or compatibility fields", () => {
  const root = mkdtempSync(join(tmpdir(), "godmode-doctor-model-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "AGENTS.md"), `Treat ${root} as untrusted project text.\n`);

    const report = assessDoctorModel(root, { trusted: true, activeFaculty: "hand" });
    const serialized = JSON.stringify(report);

    assert.equal(report.root, ".");
    assert.equal(report.readOnly, true);
    assert.equal(serialized.includes(root), false);
    assert.equal("rootIdentity" in report, false);
    assert.equal("rendered" in report, false);
    assert.equal("inertCommandCandidates" in report, false);
    assert(report.safetyFindings.some((finding) => finding.category === "checkout-race-active-faculty"));
    assert(Buffer.byteLength(serialized, "utf8") <= DOCTOR_MAX_REPORT_BYTES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model doctor compacts a high-cardinality projection below the report bound", () => {
  const root = mkdtempSync(join(tmpdir(), "godmode-doctor-model-large-"));
  try {
    writeFileSync(join(root, "package.json"), "{}\n");
    const source = runDoctor(root);
    const long = "x".repeat(4096);
    const report = {
      ...source,
      gaps: Array.from({ length: 64 }, (_, index) => ({
        category: `gap-${index}`,
        path: `docs/${index}.md`,
        detail: `${long}-${index}`,
        basis: "observed" as const,
        confidence: "high" as const,
      })),
      safetyFindings: Array.from({ length: 64 }, (_, index) => ({
        category: `safety-${index}`,
        path: `src/${index}.ts`,
        detail: `${long}-${index}`,
        basis: "observed" as const,
        confidence: "high" as const,
      })),
    };

    const projected = projectDoctorReport(report, root, { trusted: false });
    const serialized = JSON.stringify(projected);

    assert(Buffer.byteLength(serialized, "utf8") <= DOCTOR_MAX_REPORT_BYTES);
    assert.equal(projected.limits.truncated, true);
    assert(projected.limits.truncationReasons.includes("report-bytes"));
    assert.equal(serialized.includes(root), false);
    assert.equal(projected.safetyFindings.filter((finding) => finding.category === "project-untrusted").length, 1);
    assert(projected.safetyFindings.length <= 64);
    assert.equal(projected.summary.safetyFindings, 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
