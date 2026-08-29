import type { GodmodeSnapshot } from "./types.ts";

const SAFE_WHILE_HAND = new Set([
  "read", "grep", "find", "ls",
  "godmode_control",
  "subagent_supervisor",
  "contact_supervisor",
  "web_search",
  "fetch_content",
  "get_search_content",
]);

export function handOwnsCheckout(snapshot: GodmodeSnapshot): boolean {
  return snapshot.activeRun?.faculty === "hand" && ["launching", "running", "attention", "stopping"].includes(snapshot.activeRun.phase);
}

export function mutationGuard(toolName: string, snapshot: GodmodeSnapshot): { block: true; reason: string } | undefined {
  if (!handOwnsCheckout(snapshot) || SAFE_WHILE_HAND.has(toolName)) return undefined;
  return {
    block: true,
    reason: `Godmode Hand owns the shared checkout while ${snapshot.activeRun?.phase}; Primary tool '${toolName}' is blocked until the Hand reaches terminal status. Use narrow read/grep/find/ls inspection, documented read-only web tools, or godmode_control.`,
  };
}
