import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import { ControlSchema, DelegateSchema, registerGodmodeTools } from "../../src/tools.ts";

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

test("Primary and control metadata prohibit completion polling and bound status guidance", () => {
  const extensionSource = readFileSync(new URL("../../src/extension.ts", import.meta.url), "utf8");
  const primaryGuidance = extensionSource.match(/export const PRIMARY_GUIDANCE = `([\s\S]*?)`;/)?.[1];
  assert(primaryGuidance);
  const registered: any[] = [];
  registerGodmodeTools({ registerTool(tool: any) { registered.push(tool); } } as any, {} as any);
  const control = registered.find((tool) => tool.name === "godmode_control");
  assert(control);
  const exactProhibition = /Never call godmode_control status merely to check whether a queued or running faculty has finished\./i;
  const exactDefault = /Automatic completion delivery is the default\./i;
  const exactExceptions = /Use godmode_control status only when the user explicitly requests a snapshot, when recovering unknown session state, or when diagnosing a genuinely missing completion or inconsistent state\./i;
  const exactTokenWarning = /Repeated status calls waste tokens\./i;
  for (const guidance of [primaryGuidance, control.description, control.promptSnippet]) {
    assert.match(guidance, exactDefault);
    assert.match(guidance, exactProhibition);
    assert.match(guidance, exactExceptions);
    assert.match(guidance, exactTokenWarning);
  }
});
