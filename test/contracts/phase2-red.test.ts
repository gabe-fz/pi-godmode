import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderAssignment, validateDelegation } from "../../src/faculties.ts";
import { applyPhaseTransition, validateWorkflowRecord } from "../../src/workflow-state.ts";
import { workflowRecord } from "../fixtures/workflow.ts";

const audit = {
  actor: "Primary" as const,
  timestamp: "2026-09-04T01:00:00.000Z",
  reason: "Primary observed the controlled Phase 2 contract failure.",
  reference: "evidence:phase2-red",
};

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "godmode-phase2-red-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "feature.ts"), "export const feature = false;\n");
  writeFileSync(join(root, "test", "feature.test.ts"), "import assert from 'node:assert/strict';\nassert.equal(false, true);\n");
  return root;
}

function packet(overrides: Record<string, unknown> = {}) {
  return {
    ...workflowRecord({
      classification: "feature",
      requirementIds: ["FR-1"],
      expectedPaths: ["src/feature.ts", "test/feature.test.ts"],
      roadmap: [{ id: "implement-fr-1", requirementIds: ["FR-1"], title: "Implement and verify FR-1", status: "pending" }],
    }),
    packetAuthor: "Primary",
    acceptanceChecks: ["node --test test/feature.test.ts"],
    authorityConstraints: ["Hand may change only expected paths and may not weaken the red test."],
    ...overrides,
  };
}

function atGate(record: any, gate: "red-test-observed" | "tdd-waived") {
  let current = record;
  for (const to of ["classified", "specified", "red-test-ready", gate] as const) {
    current = applyPhaseTransition(current, { ...audit, to });
  }
  return current;
}

function handInput(expectedPaths = ["src/feature.ts", "test/feature.test.ts"]) {
  return {
    faculty: "hand" as const,
    title: "Implement FR-1",
    task: "Implement the packet without weakening its red test.",
    expectedPaths,
    acceptanceChecks: ["node --test test/feature.test.ts"],
  };
}

test("FR-1 specified packets require checks, authority constraints, and Primary authorship", () => {
  const incomplete = packet({ acceptanceChecks: [], authorityConstraints: [], packetAuthor: "Hand" });
  const result = validateWorkflowRecord(incomplete);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /packet|check|authority|Primary/i);
});

test("FR-1 packet roadmap covers exactly declared numbered requirements", () => {
  const mismatch = packet({ requirementIds: ["FR-1", "FR-3"] });
  const result = validateWorkflowRecord(mismatch);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /roadmap|requirement|FR-3/i);
});

test("FR-3 executable feature admission rejects Hand before observed red evidence", () => {
  const cwd = checkout();
  assert.throws(() => validateDelegation(handInput(), cwd, packet() as any), /red|TDD|waiver|phase/i);
});

test("FR-3 admits an attributable feature red and renders the canonical packet", () => {
  const cwd = checkout();
  const source = "import assert from 'node:assert/strict';\nassert.equal(false, true);\n";
  const record = atGate(packet({
    redTestEvidence: {
      id: "red-1",
      command: "node --test test/feature.test.ts",
      environment: "Disposable local checkout with Node.js test runner.",
      exitStatus: 1,
      requirementIds: ["FR-1"],
      testPath: "test/feature.test.ts",
      testContentHash: createHash("sha256").update(source).digest("hex"),
      observedBy: "Primary",
      observedAt: audit.timestamp,
      failureKind: "missing-behavior",
      outputExcerpt: "Expected false to equal true",
    },
  }), "red-test-observed");
  const normalized = validateDelegation(handInput(), cwd, record);
  assert.equal(normalized.expectedPaths.includes("test/feature.test.ts"), true);
  const assignment = renderAssignment(normalized);
  assert.match(assignment, /Specification packet/);
  assert.match(assignment, /Observed red-test evidence/);
  assert.match(assignment, /authority constraints/i);
});

test("FR-3 setup-only or irrelevant failure evidence is not an intended red", () => {
  const cwd = checkout();
  const record = atGate(packet({
    redTestEvidence: {
      id: "red-1",
      command: "node --test test/feature.test.ts",
      environment: "Disposable local checkout with Node.js test runner.",
      exitStatus: 1,
      requirementIds: ["FR-1"],
      testPath: "test/feature.test.ts",
      testContentHash: createHash("sha256").update("different").digest("hex"),
      observedBy: "Primary",
      observedAt: audit.timestamp,
      failureKind: "setup-failure",
      outputExcerpt: "Cannot find module dependency",
    },
  }), "red-test-observed");
  assert.throws(() => validateDelegation(handInput(), cwd, record as any), /intended|missing behavior|setup|red/i);
});

test("FR-3 TDD waivers require a narrow seam, Primary actor, scope, date, and compensating check", () => {
  const cwd = checkout();
  const record = atGate(packet({
    classification: "documentation/configuration",
    tddWaiver: {
      id: "waiver-1",
      reason: "Documentation only.",
      approver: "Hand",
    },
  }), "tdd-waived");
  assert.throws(() => validateDelegation(handInput(["src/feature.ts"]), cwd, record as any), /waiver|seam|Primary|scope|date|compensating/i);
});

test("FR-3 accepts a valid documentation-only narrow waiver", () => {
  const cwd = checkout();
  const record = atGate(packet({
    classification: "documentation/configuration",
    tddWaiver: {
      id: "waiver-1",
      item: "work-1",
      requirementIds: ["FR-1"],
      inapplicableSeam: "No executable seam applies to documentation-only behavior.",
      reason: "Documentation only; no executable behavior changes.",
      approver: "Primary",
      date: "2026-09-04",
      scope: ["src/feature.ts", "test/feature.test.ts"],
      compensatingCheck: "node --test test/feature.test.ts",
    },
  }), "tdd-waived");
  assert.doesNotThrow(() => validateDelegation(handInput(), cwd, record));
});

test("FR-4 Hand admission rejects changed red-test content and expected-path expansion", () => {
  const cwd = checkout();
  const source = "import assert from 'node:assert/strict';\nassert.equal(false, true);\n";
  const record = atGate(packet({
    redTestEvidence: {
      id: "red-1",
      command: "node --test test/feature.test.ts",
      environment: "Disposable local checkout with Node.js test runner.",
      exitStatus: 1,
      requirementIds: ["FR-1"],
      testPath: "test/feature.test.ts",
      testContentHash: createHash("sha256").update(source).digest("hex"),
      observedBy: "Primary",
      observedAt: audit.timestamp,
      failureKind: "missing-behavior",
      outputExcerpt: "Expected false to equal true",
    },
  }), "red-test-observed");

  writeFileSync(join(cwd, "test", "feature.test.ts"), "import assert from 'node:assert/strict';\nassert.ok(true);\n");
  assert.throws(() => validateDelegation(handInput(), cwd, record as any), /integrity|hash|changed|weaken/i);
  assert.throws(() => validateDelegation(handInput(["src/feature.ts", "README.md"]), cwd, record as any), /scope|expected path|packet|expansion/i);
});
