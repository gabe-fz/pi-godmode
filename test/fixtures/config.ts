import type { GodmodeConfig } from "../../src/types.ts";

export function validConfig(): GodmodeConfig {
  return {
    schemaVersion: 1,
    godmodePolicy: {
      allowedModels: [{ provider: "openai-codex", model: "gpt-5.6-sol" }],
      minimumThinking: "medium",
    },
    faculties: {
      eye: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "xhigh", timeoutMs: 900_000 },
      hand: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "xhigh", timeoutMs: 1_800_000 },
      scale: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "medium", timeoutMs: 900_000 },
    },
  };
}
