import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runDoctor, type DoctorOptions } from "./doctor.ts";
import { parseGodmodeCommand } from "./command-parser.ts";
import { boundedStatus } from "./status.ts";
import type { DoctorReport } from "./types.ts";
import type { GodmodeMode } from "./mode.ts";

type GodmodeSessionUI = Pick<ExtensionContext["ui"], "setStatus" | "notify">;

export interface GodmodeSessionContext {
  hasUI: boolean;
  ui: GodmodeSessionUI;
}

export async function initializeGodmodeSession(
  mode: Pick<GodmodeMode, "snapshot" | "enable">,
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  ctx: GodmodeSessionContext,
): Promise<void> {
  try {
    if (mode.snapshot.phase === "off") {
      const inactive = pi.getActiveTools().filter((name) => name !== "godmode_delegate" && name !== "godmode_control");
      pi.setActiveTools(inactive);
      if (ctx.hasUI) ctx.ui.setStatus("godmode", undefined);
    }

    await mode.enable();
  } catch (error) {
    if (ctx.hasUI) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        ctx.ui.notify(`Godmode startup enable failed: ${detail}. Godmode remains off; fix the issue and run /godmode to retry.`, "error");
      } catch { /* startup must continue even if the UI cannot report the failure */ }
    }
  }
}

export type GodmodeToggleMode = Pick<GodmodeMode, "snapshot" | "enable" | "disable">;

export interface GodmodeTuiCommandContext {
  hasUI: boolean;
  ui: Pick<ExtensionContext["ui"], "notify">;
  waitForIdle(): Promise<void>;
}

export async function toggleGodmodeTui(mode: GodmodeToggleMode, ctx: GodmodeTuiCommandContext): Promise<void> {
  await ctx.waitForIdle();
  const snapshot = mode.snapshot;
  if (snapshot.phase === "off") {
    try {
      await mode.enable();
      if (ctx.hasUI) ctx.ui.notify("Godmode enabled.", "info");
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Godmode enable failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
    return;
  }

  if (snapshot.phase !== "active" && snapshot.phase !== "degraded") {
    if (ctx.hasUI) ctx.ui.notify(`Godmode is currently ${snapshot.phase}; try again shortly.`, "warning");
    return;
  }

  try {
    if (snapshot.activeRun) {
      await mode.disable({ stopActive: true });
      if (ctx.hasUI) ctx.ui.notify("Faculty stopped and Godmode disabled.", "info");
    } else {
      await mode.disable();
      if (ctx.hasUI) ctx.ui.notify("Godmode disabled.", "info");
    }
  } catch (error) {
    if (ctx.hasUI) {
      const action = snapshot.activeRun ? "cleanup" : "disable";
      ctx.ui.notify(`Godmode ${action} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
}

/**
 * The command context is deliberately the smallest host surface needed by the
 * Phase 5 command. Keeping the handler here makes its behavior testable
 * without constructing the rest of the extension runtime.
 */
export interface GodmodeCommandContext extends GodmodeTuiCommandContext {
  mode: ExtensionCommandContext["mode"];
  cwd: string;
}

export interface GodmodeCommandHandlerDependencies {
  mode: GodmodeToggleMode;
  /** Replaceable for tests; production uses the read-only doctor runner. */
  runDoctor?: (root: string, options?: DoctorOptions) => DoctorReport;
  /** Replaceable for non-UI tests; production writes the existing console output. */
  output?: (message: string) => void;
  /** The existing TUI toggle path, replaceable only to observe delegation. */
  toggleTui?: (mode: GodmodeToggleMode, context: GodmodeTuiCommandContext) => Promise<void>;
  /** Lets the extension bind its current session context before mode calls. */
  onContext?: (context: ExtensionCommandContext) => void;
}

const GODMODE_USAGE = "Usage: /godmode | /godmode doctor | /godmode doctor --apply (read-only; apply unavailable in Phase 5)";

/**
 * Build the single registered /godmode handler. Doctor branches do not wait
 * for or control faculties, and all non-TUI output stays on the old bounded
 * status path.
 */
export function createGodmodeCommandHandler(
  dependencies: GodmodeCommandHandlerDependencies,
): (args: string | readonly string[], context: GodmodeCommandContext) => Promise<void> {
  const doctor = dependencies.runDoctor ?? runDoctor;
  const output = dependencies.output ?? ((message: string) => console.log(message));
  const toggle = dependencies.toggleTui ?? toggleGodmodeTui;
  return async (args, context): Promise<void> => {
    // The registered host supplies a full ExtensionCommandContext; the
    // narrowed type keeps this factory usable with small test fakes.
    dependencies.onContext?.(context as unknown as ExtensionCommandContext);
    const command = parseGodmodeCommand(args);
    if (command === "invalid") {
      if (context.hasUI) context.ui.notify(GODMODE_USAGE, "warning");
      else output(GODMODE_USAGE);
      return;
    }
    if (command === "doctor" || command === "apply-unavailable") {
      // The snapshot is read once for the race annotation only. No wait,
      // stop, delegate, toggle, or mode transition occurs in this branch.
      const report = doctor(context.cwd, { activeFaculty: dependencies.mode.snapshot.activeRun?.faculty });
      if (context.hasUI) context.ui.notify(report.rendered, "info");
      else output(report.rendered);
      return;
    }
    if (context.mode !== "tui") {
      const report = JSON.stringify(boundedStatus(dependencies.mode.snapshot));
      if (context.hasUI) context.ui.notify(report, "info");
      else output(report);
      return;
    }
    await toggle(dependencies.mode, context);
  };
}

/** Register the same handler used by the extension and command integration tests. */
export function registerGodmodeCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  dependencies: GodmodeCommandHandlerDependencies,
): void {
  pi.registerCommand("godmode", {
    description: "Toggle constrained Godmode orchestration",
    handler: createGodmodeCommandHandler(dependencies),
  });
}

/** Compatibility spelling for hosts that prefer a factory verb. */
export const makeGodmodeCommandHandler = createGodmodeCommandHandler;
