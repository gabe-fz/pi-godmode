import type { WorkflowRecord } from "../../src/types.ts";

export function workflowRecord(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    workItemId: "work-1",
    classification: "feature",
    goal: "A user can recover the current workflow state from the active session branch.",
    requirementIds: ["FR-2", "FR-9"],
    nonGoals: ["No model-facing workflow mutation tool."],
    expectedPaths: ["src/workflow-state.ts", "src/session-ledger.ts"],
    phase: "draft",
    roadmap: [
      { id: "item-1", requirementIds: ["FR-2"], title: "Canonical transitions", status: "pending" },
      { id: "item-2", requirementIds: ["FR-9"], title: "Branch recovery", status: "pending" },
    ],
    history: [],
    nextGate: "classification",
    blockers: [],
    residualRisks: [],
    evidence: [],
    ...overrides,
  };
}
