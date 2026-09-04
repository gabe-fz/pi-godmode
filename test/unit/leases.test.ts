import assert from "node:assert/strict";
import { test } from "node:test";
import { ActiveToolLease } from "../../src/active-tools.ts";
import { ModelLease, type PiModel } from "../../src/model-lease.ts";
import { validConfig } from "../fixtures/config.ts";

function modelHost(options: { deny?: Set<string>; clampThinking?: boolean } = {}) {
  const models: PiModel[] = [{ provider: "old", id: "model" }, { provider: "openai-codex", id: "gpt-5.6-sol" }];
  let current = models[0]!;
  let thinking: "low" | "medium" | "high" = "high";
  return {
    host: {
      findModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
      isModelScoped: () => true,
      async setModel(model: PiModel) { if (options.deny?.has(`${model.provider}/${model.id}`)) return false; current = model; return true; },
      getModel: () => current,
      getThinkingLevel: () => thinking,
      setThinkingLevel(level: typeof thinking) { thinking = options.clampThinking ? "low" : level; },
    },
    current: () => current,
    thinking: () => thinking,
  };
}

test("model lease promotes and restores exact prior state", async () => {
  const fixture = modelHost();
  const lease = new ModelLease();
  await lease.acquire(validConfig(), fixture.host);
  assert.equal(`${fixture.current().provider}/${fixture.current().id}`, "openai-codex/gpt-5.6-sol");
  assert.equal(fixture.thinking(), "medium");
  await lease.restore(fixture.host);
  assert.equal(`${fixture.current().provider}/${fixture.current().id}`, "old/model");
  assert.equal(fixture.thinking(), "high");
  await lease.restore(fixture.host); // idempotent
});

test("model lease rolls back candidate and thinking verification failures", async () => {
  const denied = modelHost({ deny: new Set(["openai-codex/gpt-5.6-sol"]) });
  await assert.rejects(new ModelLease().acquire(validConfig(), denied.host), /No configured Godmode/);
  assert.equal(`${denied.current().provider}/${denied.current().id}`, "old/model");
  const clamped = modelHost({ clampThinking: true });
  await assert.rejects(new ModelLease().acquire(validConfig(), clamped.host), /verification failed/);
  assert.equal(`${clamped.current().provider}/${clamped.current().id}`, "old/model");
});

test("active-tool lease removes generic subagent execution and waiting, then conservatively restores owned deltas", () => {
  let active = ["read", "subagent", "subagent_wait", "other"];
  const lease = new ActiveToolLease({ getActiveTools: () => [...active], setActiveTools: (names) => { active = [...names]; } });
  lease.acquire();
  assert(!active.includes("subagent"));
  assert(!active.includes("subagent_wait"));
  assert(active.includes("godmode_delegate") && active.includes("godmode_workflow") && active.includes("godmode_control"));
  active.push("new_other_extension_tool");
  lease.release();
  assert(active.includes("subagent"));
  assert(active.includes("subagent_wait"));
  assert(active.includes("new_other_extension_tool"));
  assert(!active.includes("godmode_delegate") && !active.includes("godmode_workflow") && !active.includes("godmode_control"));
});
