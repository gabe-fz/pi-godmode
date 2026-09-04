import type { WorkflowRecord } from "../../src/types.ts";

export function workflowRecord(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  const record: WorkflowRecord = {
    workItemId: "work-1",
    classification: "feature",
    goal: "A user can recover the current workflow state from the active session branch.",
    requirementIds: ["FR-2", "FR-9"],
    functionalRequirements: [
      { id: "FR-2", description: "The workflow exposes one canonical state per active work item.", interface: "session ledger" },
      { id: "FR-9", description: "A reopened session recovers the latest valid workflow snapshot.", interface: "session lifecycle" },
    ],
    nonGoals: ["No arbitrary model-facing workflow authority or acceptance tool."],
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
    packetAuthor: "Primary",
    acceptanceChecks: ["npm test"],
    authorityConstraints: ["Hand may change only expected paths and may not weaken tests."],
    ...overrides,
  };
  // Most tests narrow requirementIds to a one-item packet. Keep this fixture
  // convenient while still exercising the structured packet requirement.
  if (overrides.functionalRequirements === undefined) {
    record.functionalRequirements = record.requirementIds.map((id) => ({
      id,
      description: `The system provides the observable behavior required by ${id}.`,
      interface: "session workflow interface",
    }));
  }
  return record;
}
