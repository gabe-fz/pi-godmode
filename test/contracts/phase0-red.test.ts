import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateDelegation } from "../../src/faculties.ts";
import { applyPhaseTransition, applyRoadmapTransition, validateWorkflowRecord } from "../../src/workflow-state.ts";
import { workflowRecord } from "../fixtures/workflow.ts";

const audit = {
  actor: "Primary" as const,
  timestamp: "2026-09-04T00:00:00.000Z",
  reason: "Controlled contract fixture.",
  reference: "evidence:phase0-contract",
};

test("FR-1 Hand admission rejects an assignment without a Primary packet", () => {
  assert.throws(() => validateDelegation({
    faculty: "hand",
    title: "Implement",
    task: "Implement a bounded change.",
    expectedPaths: ["src/example.ts"],
    acceptanceChecks: ["npm test"],
  }, process.cwd()), /packet|specification|classification|requirement|roadmap|authority/i);
});

test("FR-1 rejects non-numbered requirement identifiers", () => {
  const result = validateWorkflowRecord(workflowRecord({ requirementIds: ["REQ-X"] }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /numbered|requirement|FR-/i);
});

test("FR-6 Scale waiver cannot bypass mandatory review without bounded waiver metadata", () => {
  let record = workflowRecord();
  for (const to of ["classified", "specified", "red-test-ready", "red-test-observed", "hand-running", "hand-handoff", "primary-verifying", "evidence-ready"] as const) {
    record = applyPhaseTransition(record, { ...audit, to });
  }
  for (const item of record.roadmap) {
    record = applyRoadmapTransition(record, item.id, { ...audit, actor: "Hand", to: "implemented-unverified" });
    record = applyRoadmapTransition(record, item.id, { ...audit, to: "verified" });
  }
  assert.throws(() => applyPhaseTransition(record, {
    ...audit,
    to: "scale-waived",
    reason: "Scale unavailable.",
    reference: "decision:no-capacity",
  }), /waiver|scope|approver|compensating|risk/i);
});

test("FR-10 doctor has a bounded static-discovery implementation seam", () => {
  const source = readFileSync(new URL("../../src/extension.ts", import.meta.url), "utf8");
  assert.match(source, /(?:run|create|assess)Doctor|doctor\.ts/, "missing read-only doctor implementation seam");
});

test("FR-11 command grammar recognizes doctor without treating it as an unknown toggle argument", () => {
  const source = readFileSync(new URL("../../src/extension.ts", import.meta.url), "utf8");
  assert.match(source, /doctor(?:\s+--apply)?/, "missing doctor command grammar");
  assert.doesNotMatch(source, /if \(args\.trim\(\)\) \{ ctx\.ui\.notify\("Usage: \/godmode"/, "all nonempty arguments still take the legacy usage path");
});
