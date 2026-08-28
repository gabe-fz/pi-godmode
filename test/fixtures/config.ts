import type { GodmodeConfig } from "../../src/types.ts";

export function validConfig(): GodmodeConfig {
  return {
    schemaVersion: 1,
    nucleusPolicy: {
      allowedModels: [{ provider: "primary", model: "high" }],
      minimumThinking: "high",
    },
    faculties: {
      eye: { provider: "child", model: "eye", thinking: "low", timeoutMs: 900_000 },
      hand: { provider: "child", model: "hand", thinking: "medium", timeoutMs: 1_800_000 },
      scale: { provider: "child", model: "scale", thinking: "medium", timeoutMs: 900_000 },
    },
  };
}
