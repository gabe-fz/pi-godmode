/** The exact command grammar used by the extension. Parsing is pure: it has
 * no access to mode state and cannot cause a toggle or apply. */
export interface ApplyReplacementPreviewCommand {
  action: "apply-replacement-preview";
  path: "docs/GODMODE_WORKFLOW.md" | ".godmode/validation-profile.json";
}

export interface ApplyTokenCommand {
  action: "apply-confirm" | "apply-recover";
  token: string;
}

export type GodmodeCommand =
  | "toggle"
  | "doctor"
  | "apply-preview"
  | ApplyReplacementPreviewCommand
  | ApplyTokenCommand
  | "invalid";
export type CommandAction = GodmodeCommand;

const ALLOWED_REPLACEMENT_PATHS = new Set([
  ".godmode/validation-profile.json",
  "docs/GODMODE_WORKFLOW.md",
]);
// The parser accepts the bounded textual token form (the apply manager still
// requires its cryptographic token). This keeps malformed whitespace and
// option values out of the command state machine without making parsing stateful.
const BOUNDED_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function parseGodmodeCommand(args: string | readonly string[]): GodmodeCommand {
  const value = typeof args === "string" ? args.trim() : args.join(" ").trim();
  if (value === "") return "toggle";
  if (value === "doctor") return "doctor";
  if (value === "doctor --apply") return "apply-preview";

  const replacement = value.match(/^doctor --apply --replace ([^\s]+)$/u);
  if (replacement && ALLOWED_REPLACEMENT_PATHS.has(replacement[1] ?? "")) {
    return { action: "apply-replacement-preview", path: replacement[1] as ApplyReplacementPreviewCommand["path"] };
  }

  const confirmation = value.match(/^doctor --apply --(confirm|recover) ([^\s]+)$/u);
  if (confirmation && BOUNDED_TOKEN.test(confirmation[2] ?? "")) {
    return {
      action: confirmation[1] === "confirm" ? "apply-confirm" : "apply-recover",
      token: confirmation[2] ?? "",
    };
  }
  return "invalid";
}

/** Short aliases keep the helper convenient for command-focused callers while
 * preserving one implementation of the exact grammar. */
export const parseCommand = parseGodmodeCommand;
export const parseGodmodeArgs = parseGodmodeCommand;
