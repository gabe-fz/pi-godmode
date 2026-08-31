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
  const contextSchema = DelegateSchema.properties.contextFiles as unknown as { description?: string; items: { description?: string } };
  assert.match(contextSchema.description ?? "", /Absolute paths inside the checkout/);
  assert.match(contextSchema.description ?? "", /outside paths remain absolute/);
  assert.match(contextSchema.description ?? "", /untrusted/);
  assert.match(contextSchema.items.description ?? "", /may expose sensitive data/);
  const expectedSchema = DelegateSchema.properties.expectedPaths as unknown as { description?: string; items: { description?: string } };
  assert.match(expectedSchema.description ?? "", /always confined to the active checkout/);
  assert.match(expectedSchema.description ?? "", /absolute paths that resolve outside/);
  assert.match(expectedSchema.items.description ?? "", /never an absolute path/);
});

test("control schema has no selectable child id and rejects extra fields", () => {
  const control = Compile(ControlSchema);
  assert(control.Check({ action: "status" }));
  assert(control.Check({ action: "steer", message: "guidance" }));
  assert(control.Check({ action: "extend", extensionMs: 60_000 }));
  assert.equal(control.Check({ action: "extend", extensionMs: 300_001 }), false);
  assert.equal(control.Check({ action: "stop", id: "other-child" }), false);
  assert.equal(control.Check({ action: "resume", message: "x" }), false);
});

test("Primary and tool metadata prohibit duplicate delegated work and completion polling", () => {
  const extensionSource = readFileSync(new URL("../../src/extension.ts", import.meta.url), "utf8");
  const primaryGuidance = extensionSource.match(/export const PRIMARY_GUIDANCE = `([\s\S]*?)`;/)?.[1];
  assert(primaryGuidance);
  const registered: any[] = [];
  registerGodmodeTools({ registerTool(tool: any) { registered.push(tool); } } as any, {} as any);
  const delegate = registered.find((tool) => tool.name === "godmode_delegate");
  const control = registered.find((tool) => tool.name === "godmode_control");
  assert(delegate);
  assert(control);
  const exactNoDuplicateWork = /After delegation, do not independently repeat or continue the Faculty's assigned work while it is active\./i;
  for (const guidance of [primaryGuidance, delegate.description, delegate.promptSnippet]) {
    assert.match(guidance, exactNoDuplicateWork);
  }
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

test("delegate launch notice tells the Primary not to duplicate active Faculty work", async () => {
  const registered: any[] = [];
  const mode = {
    async delegate() { return { runId: "run-1", faculty: "eye", agent: "godmode-eye", state: "running" }; },
  };
  registerGodmodeTools({ registerTool(tool: any) { registered.push(tool); } } as any, mode as any);
  const delegate = registered.find((tool) => tool.name === "godmode_delegate");
  const result = await delegate.execute("call-1", { faculty: "eye", title: "Inspect", task: "Inspect source" });
  assert.match(result.content[0].text, /Do not independently repeat or continue the Faculty's assigned work while it is active\./i);
});
