import assert from "node:assert/strict";
import { test } from "node:test";
import { ActiveToolLease } from "../../src/active-tools.ts";
import { ModelLease, type PiModel } from "../../src/model-lease.ts";
import { validConfig } from "../fixtures/config.ts";

function modelHost(options: { deny?: Set<string>; clampThinking?: boolean } = {}) {
  const models: PiModel[] = [{ provider: "old", id: "model" }, { provider: "primary", id: "high" }];
  let current = models[0]!;
  let thinking: "medium" | "high" = "medium";
  return {
    host: {
      findModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
      isModelScoped: () => true,
      async setModel(model: PiModel) { if (options.deny?.has(`${model.provider}/${model.id}`)) return false; current = model; return true; },
      getModel: () => current,
      getThinkingLevel: () => thinking,
      setThinkingLevel(level: typeof thinking) { thinking = options.clampThinking ? "medium" : level; },
    },
    current: () => current,
    thinking: () => thinking,
  };
}

test("model lease promotes and restores exact prior state", async () => {
  const fixture = modelHost();
  const lease = new ModelLease();
  await lease.acquire(validConfig(), fixture.host);
  assert.equal(`${fixture.current().provider}/${fixture.current().id}`, "primary/high");
  assert.equal(fixture.thinking(), "high");
  await lease.restore(fixture.host);
  assert.equal(`${fixture.current().provider}/${fixture.current().id}`, "old/model");
  assert.equal(fixture.thinking(), "medium");
  await lease.restore(fixture.host); // idempotent
});

test("model lease rolls back candidate and thinking verification failures", async () => {
  const denied = modelHost({ deny: new Set(["primary/high"]) });
  await assert.rejects(new ModelLease().acquire(validConfig(), denied.host), /No configured Nucleus/);
  assert.equal(`${denied.current().provider}/${denied.current().id}`, "old/model");
  const clamped = modelHost({ clampThinking: true });
  await assert.rejects(new ModelLease().acquire(validConfig(), clamped.host), /verification failed/);
  assert.equal(`${clamped.current().provider}/${clamped.current().id}`, "old/model");
});

test("active-tool lease removes subagent and conservatively restores owned deltas", () => {
  let active = ["read", "subagent", "other"];
  const lease = new ActiveToolLease({ getActiveTools: () => [...active], setActiveTools: (names) => { active = [...names]; } });
  lease.acquire();
  assert(!active.includes("subagent"));
  assert(active.includes("godmode_delegate") && active.includes("godmode_control"));
  active.push("new_other_extension_tool");
  lease.release();
  assert(active.includes("subagent"));
  assert(active.includes("new_other_extension_tool"));
  assert(!active.includes("godmode_delegate") && !active.includes("godmode_control"));
});
