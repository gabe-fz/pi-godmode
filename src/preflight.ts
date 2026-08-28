import { realpathSync } from "node:fs";
import type { SubagentLaunchContractInput, SubagentLaunchContractResult } from "pi-subagents/preflight";
import { AGENT_NAMES, CAPABILITY_TOOL_UNION, FACULTY_TOOLS } from "./faculties.ts";
import type { Faculty, GodmodeConfig } from "./types.ts";

export interface PreflightApi {
  resolve(input: SubagentLaunchContractInput): Promise<SubagentLaunchContractResult>;
}

export const DEFAULT_PREFLIGHT_API: PreflightApi = {
  async resolve(input) {
    const { resolveSubagentLaunchContract } = await import("pi-subagents/preflight");
    return resolveSubagentLaunchContract(input);
  },
};

function sorted(values: readonly string[]): string[] { return [...values].sort(); }
function equalSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function baseModel(value: string | undefined): string | undefined {
  if (!value) return value;
  const colon = value.lastIndexOf(":");
  return colon > value.indexOf("/") ? value.slice(0, colon) : value;
}

export async function preflightFaculties(input: {
  api?: PreflightApi;
  config: GodmodeConfig;
  cwd: string;
  availableModels: ReadonlyArray<{ provider: string; id: string; reasoning?: boolean }>;
  parentModel?: { provider: string; id: string };
  sessionRoot?: string;
}): Promise<void> {
  const api = input.api ?? DEFAULT_PREFLIGHT_API;
  const cwd = realpathSync(input.cwd);
  const expectedAgents = sorted(Object.values(AGENT_NAMES));
  for (const faculty of Object.keys(AGENT_NAMES) as Faculty[]) {
    const config = input.config.faculties[faculty];
    const expectedModel = `${config.provider}/${config.model}`;
    const result = await api.resolve({
      agent: AGENT_NAMES[faculty],
      task: `Godmode preflight for ${faculty}.`,
      cwd,
      context: "fresh",
      model: `${expectedModel}:${config.thinking}`,
      availableModels: input.availableModels,
      ...(input.parentModel ? { parentModel: input.parentModel } : {}),
      ...(input.sessionRoot ? { sessionRoot: input.sessionRoot } : {}),
      capabilityCeiling: {
        version: 1,
        allowedAgents: expectedAgents,
        allowedTools: sorted(CAPABILITY_TOOL_UNION),
        denyExtensions: true,
        sources: ["pi-godmode"],
      },
    });
    if (!result.ok) throw new Error(`Godmode ${faculty} preflight failed (${result.code}): ${result.message}`);
    const contract = result.contract;
    if (contract.agent.name !== AGENT_NAMES[faculty] || contract.agent.source !== "runtime") throw new Error(`Godmode ${faculty} preflight resolved the wrong agent identity/source.`);
    if (contract.context !== "fresh") throw new Error(`Godmode ${faculty} preflight did not resolve fresh context.`);
    if (baseModel(contract.model) !== expectedModel || contract.thinking !== config.thinking) throw new Error(`Godmode ${faculty} preflight resolved model/thinking '${contract.model ?? "none"}/${contract.thinking ?? "none"}', expected '${expectedModel}/${config.thinking}'.`);
    if (contract.modelCandidates.length !== 1 || baseModel(contract.modelCandidates[0]) !== expectedModel) throw new Error(`Godmode ${faculty} preflight admitted fallback model candidates.`);
    if (!equalSet(contract.tools.effectiveAllowlist, FACULTY_TOOLS[faculty])) throw new Error(`Godmode ${faculty} preflight resolved unexpected tools: ${contract.tools.effectiveAllowlist.join(", ")}.`);
    if (!contract.tools.explicitAllowlist) throw new Error(`Godmode ${faculty} preflight did not resolve an explicit tool allowlist.`);
    if (!contract.tools.disableAmbientExtensions || contract.tools.configuredExtensions.length || contract.tools.toolExtensionPaths.length || contract.tools.effectiveMcpTools.length) {
      throw new Error(`Godmode ${faculty} preflight did not suppress ambient/configured/MCP extensions.`);
    }
    if (realpathSync(contract.roots.cwd) !== cwd) throw new Error(`Godmode ${faculty} preflight resolved a different checkout.`);
    const ceiling = contract.tools.capabilityCeiling;
    if (!ceiling || ceiling.denyExtensions !== true || !equalSet(ceiling.allowedAgents ?? [], expectedAgents) || !equalSet(ceiling.allowedTools ?? [], CAPABILITY_TOOL_UNION)) {
      throw new Error(`Godmode ${faculty} preflight did not retain the session capability ceiling.`);
    }
  }
}
