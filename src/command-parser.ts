/** The one-command grammar used by the extension.  Parsing is deliberately
 * pure: it has no access to mode state and cannot cause a toggle or apply. */
export type GodmodeCommand = "toggle" | "doctor" | "apply-unavailable" | "invalid";
export type CommandAction = GodmodeCommand;

export function parseGodmodeCommand(args: string | readonly string[]): GodmodeCommand {
  const value = typeof args === "string" ? args.trim() : args.join(" ").trim();
  if (value === "") return "toggle";
  if (value === "doctor") return "doctor";
  if (value === "doctor --apply") return "apply-unavailable";
  return "invalid";
}

/** Short aliases keep the helper convenient for command-focused callers while
 * preserving one implementation of the exact grammar. */
export const parseCommand = parseGodmodeCommand;
export const parseGodmodeArgs = parseGodmodeCommand;
