import { registerSubagentCapabilityCeiling, type SubagentCapabilityCeilingHandle } from "pi-subagents/capability-ceiling";
import { AGENT_NAMES, CAPABILITY_TOOL_UNION } from "./faculties.ts";
import type { Disposable } from "./types.ts";

export interface CeilingRegistrar {
  register(sessionId: string): Disposable;
}

export const DEFAULT_CEILING_REGISTRAR: CeilingRegistrar = {
  register(sessionId: string): SubagentCapabilityCeilingHandle {
    return registerSubagentCapabilityCeiling({
      sessionId,
      source: "pi-godmode",
      ceiling: {
        allowedAgents: Object.values(AGENT_NAMES),
        allowedTools: CAPABILITY_TOOL_UNION,
        denyExtensions: true,
      },
    });
  },
};
