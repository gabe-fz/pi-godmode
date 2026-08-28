import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerFaculties, RUNTIME_AGENT_REGISTER_EVENT } from "../../src/agents.ts";
import { AGENT_NAMES, CAPABILITY_TOOL_UNION, FACULTY_TOOLS } from "../../src/faculties.ts";
import { preflightFaculties, type PreflightApi } from "../../src/preflight.ts";
import { validConfig } from "../fixtures/config.ts";

test("runtime registration publishes exact three faculties and disposes idempotently", () => {
  const requests: any[] = [];
  const disposed: string[] = [];
  const events = {
    emit(event: string, raw: unknown) {
      assert.equal(event, RUNTIME_AGENT_REGISTER_EVENT);
      const request = raw as any;
      requests.push(request);
      request.result = { ok: true, registration: { dispose: () => disposed.push(request.name) } };
    },
  };
  const registrations = registerFaculties(events, validConfig());
  assert.deepEqual(requests.map((request) => request.name), ["godmode-eye", "godmode-hand", "godmode-scale"]);
  assert.deepEqual(requests[0].definition.tools, FACULTY_TOOLS.eye);
  assert.deepEqual(requests[1].definition.tools, FACULTY_TOOLS.hand);
  assert.equal(requests[2].definition.model, "openai-codex/gpt-5.6-terra");
  registrations.forEach((registration) => registration.dispose());
  assert.deepEqual(disposed, ["godmode-eye", "godmode-hand", "godmode-scale"]);
});

test("runtime registration rolls back earlier faculties on owner failure", () => {
  const disposed: string[] = [];
  let count = 0;
  assert.throws(() => registerFaculties({ emit(_event, raw) {
    const request = raw as any;
    count++;
    request.result = count === 2 ? { ok: false, error: new Error("collision") } : { ok: true, registration: { dispose: () => disposed.push(request.name) } };
  } }, validConfig()), /collision/);
  assert.deepEqual(disposed, ["godmode-eye"]);
});

function contractFor(input: any) {
  const faculty = (Object.entries(AGENT_NAMES).find(([, name]) => name === input.agent)?.[0] ?? "eye") as keyof typeof FACULTY_TOOLS;
  const model = input.model as string;
  const thinking = model.slice(model.lastIndexOf(":") + 1);
  return {
    ok: true,
    contract: {
      agent: { name: input.agent, source: "runtime" },
      context: "fresh",
      model,
      modelCandidates: [model],
      thinking,
      tools: {
        effectiveAllowlist: [...FACULTY_TOOLS[faculty]], explicitAllowlist: true,
        disableAmbientExtensions: true, configuredExtensions: [], toolExtensionPaths: [], effectiveMcpTools: [],
        capabilityCeiling: input.capabilityCeiling,
      },
      roots: { cwd: input.cwd },
    },
  } as any;
}

test("preflight verifies exact identity/model/thinking/tools/cwd/extensions and ceiling", async () => {
  const seen: any[] = [];
  const api: PreflightApi = { async resolve(input) { seen.push(input); return contractFor(input); } };
  const cwd = mkdtempSync(join(tmpdir(), "godmode-preflight-"));
  await preflightFaculties({ api, config: validConfig(), cwd, availableModels: [{ provider: "openai-codex", id: "gpt-5.6-luna" }] });
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((input) => input.agent), Object.values(AGENT_NAMES));
  assert(seen.every((input) => input.context === "fresh"));
  assert(seen.every((input) => input.capabilityCeiling.denyExtensions));
  assert.deepEqual(seen[0].capabilityCeiling.allowedTools, [...CAPABILITY_TOOL_UNION].sort());
});

test("preflight tolerates the pi-subagents 0.58 runtime discovery gap only after verified registration", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "godmode-preflight-runtime-"));
  const api: PreflightApi = { async resolve() {
    return { ok: false, code: "missing_agent", message: "Unknown runtime agent", diagnostics: [] };
  } };
  await assert.rejects(preflightFaculties({ api, config: validConfig(), cwd, availableModels: [] }), /missing_agent/);
  await preflightFaculties({ api, config: validConfig(), cwd, availableModels: [], runtimeRegistrationVerified: true });
});

test("preflight rejects widened tools and fallback models", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "godmode-preflight-bad-"));
  let kind: "tools" | "fallback" = "tools";
  const api: PreflightApi = { async resolve(input) {
    const result = contractFor(input);
    if (kind === "tools") result.contract.tools.effectiveAllowlist.push("write");
    else result.contract.modelCandidates.push("other/fallback:low");
    return result;
  } };
  await assert.rejects(preflightFaculties({ api, config: validConfig(), cwd, availableModels: [] }), /unexpected tools/);
  kind = "fallback";
  await assert.rejects(preflightFaculties({ api, config: validConfig(), cwd, availableModels: [] }), /fallback/);
});
