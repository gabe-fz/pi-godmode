import assert from "node:assert/strict";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import { ControlSchema, DelegateSchema } from "../../src/tools.ts";

test("model-facing schemas expose no arbitrary agent/model/cwd/workflow/tool surface", () => {
  const delegate = Compile(DelegateSchema);
  const valid = { faculty: "eye", title: "Inspect", task: "Inspect source" };
  assert(delegate.Check(valid));
  for (const forbidden of ["agent", "model", "thinking", "cwd", "worktree", "workflowScript", "workflowScriptPath", "tools", "schedule", "outputPath"]) {
    assert.equal(delegate.Check({ ...valid, [forbidden]: "evil" }), false, forbidden);
  }
  assert.equal(delegate.Check({ ...valid, faculty: "oracle" }), false);
  for (const field of ["contextFiles", "expectedPaths"] as const) {
    const pathSchema = DelegateSchema.properties[field] as unknown as { description?: string; items: { description?: string } };
    assert.match(pathSchema.description ?? "", /relative to the active checkout root/);
    assert.match(pathSchema.items.description ?? "", /never an absolute path/);
  }
});

test("control schema has no selectable child id and rejects extra fields", () => {
  const control = Compile(ControlSchema);
  assert(control.Check({ action: "status" }));
  assert(control.Check({ action: "steer", message: "guidance" }));
  assert.equal(control.Check({ action: "stop", id: "other-child" }), false);
  assert.equal(control.Check({ action: "resume", message: "x" }), false);
});
