import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runDoctor, type DoctorOptions } from "./doctor.ts";
import { applyDoctorPreview, createDoctorApplyPreview, recoverDoctorPreview, type DoctorApplyManager, type DoctorApplyOptions } from "./doctor-apply.ts";
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

    // Godmode is opt-in: only the explicit TUI /godmode toggle enables it.
  } catch (error) {
    if (ctx.hasUI) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        ctx.ui.notify(`Godmode startup initialization failed: ${detail}. Fix the issue and reload Pi; use /godmode to enable explicitly.`, "error");
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
 * doctor/previewed-apply command. Keeping the handler here makes its behavior testable
 * without constructing the rest of the extension runtime.
 */
export interface GodmodeCommandContext extends GodmodeTuiCommandContext {
  mode: ExtensionCommandContext["mode"];
  cwd: string;
  /** Trust/idle are supplied by the real host context. They stay optional at
   * the type boundary for compatibility, but apply branches deny when absent. */
  isProjectTrusted?(): boolean;
  isIdle?(): boolean;
}

export interface GodmodeCommandHandlerDependencies {
  mode: GodmodeToggleMode;
  /** Replaceable for tests; production uses the read-only doctor runner. */
  runDoctor?: (root: string, options?: DoctorOptions) => DoctorReport;
  /** Replaceable for non-UI tests; production writes the existing console output. */
  output?: (message: string) => void;
  /** The existing TUI toggle path, replaceable only to observe delegation. */
  toggleTui?: (mode: GodmodeToggleMode, context: GodmodeTuiCommandContext) => Promise<void>;
  /** Optional manager/seams keep command integration deterministic in hosts. */
  doctorApplyManager?: DoctorApplyManager;
  createApplyPreview?: (root: string, report: DoctorReport, options?: DoctorApplyOptions) => ReturnType<typeof createDoctorApplyPreview>;
  applyPreview?: (root: string, token: string, options?: DoctorApplyOptions) => ReturnType<typeof applyDoctorPreview>;
  recoverPreview?: (root: string, token: string, options?: DoctorApplyOptions) => ReturnType<typeof recoverDoctorPreview>;
  /** Lets the extension bind its current session context before mode calls. */
  onContext?: (context: ExtensionCommandContext) => void;
}

// Project writes are delegated only to .godmode/validation-profile.json and
// docs/GODMODE_WORKFLOW.md; legacy PROJECT_MEMORY.md is never written.
const GODMODE_USAGE = "Usage: /godmode | /godmode doctor | /godmode doctor --apply | /godmode doctor --apply --replace <allowed path> | /godmode doctor --apply --confirm <token> | /godmode doctor --apply --recover <token>";

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
    if (command === "doctor") {
      // The snapshot is read once for the race annotation only. No wait,
      // stop, delegate, toggle, or mode transition occurs in this branch.
      const report = doctor(context.cwd, { activeFaculty: dependencies.mode.snapshot.activeRun?.faculty });
      if (context.hasUI) context.ui.notify(report.rendered, "info");
      else output(report.rendered);
      return;
    }
    if (command !== "toggle") {
      // Apply preview is read-only, but the registered command still denies
      // without an affirmative host trust decision. Missing trust is never an
      // implicit allow (unlike legacy Phase 0-5 command contexts).
      let trusted = false;
      try { trusted = context.isProjectTrusted?.() === true; } catch { /* trust failures deny below */ }
      const activeFaculty = dependencies.mode.snapshot.activeRun?.faculty;
      const deny = (message: string): void => {
        if (context.hasUI) context.ui.notify(message, "warning");
        else output(message);
      };
      if (!trusted) {
        deny("Godmode doctor apply refused: the project is not trusted; no files were changed.");
        return;
      }
      if (activeFaculty) {
        deny(`Godmode doctor apply refused while faculty ${activeFaculty} is active; no files were changed.`);
        return;
      }
      try {
        if (command === "apply-preview" || command.action === "apply-replacement-preview") {
          const replacement = command !== "apply-preview" && command.action === "apply-replacement-preview";
          const report = doctor(context.cwd);
          const applyOptions: DoctorApplyOptions = { trusted, activeFaculty };
          const previewOptions = replacement ? { ...applyOptions, replacePath: command.path } : applyOptions;
          const preview = dependencies.createApplyPreview
            ? dependencies.createApplyPreview(context.cwd, report, previewOptions)
            : createDoctorApplyPreview(context.cwd, report, { ...previewOptions, ...(dependencies.doctorApplyManager ? { manager: dependencies.doctorApplyManager } : {}) });
          if (context.hasUI) context.ui.notify(preview.rendered, "info");
          else output(preview.rendered);
          return;
        }
        // At this point the only remaining non-toggle commands are the two
        // token-bearing object states, so confirmation/recovery is explicit.
        await context.waitForIdle();
        // Re-read every effectful host gate after waiting. Waiting alone is
        // not proof: trust, affirmative idle, and no active faculty must all
        // describe this post-wait snapshot, not the pre-wait observation.
        let postWaitTrusted = false;
        try { postWaitTrusted = context.isProjectTrusted?.() === true; } catch { /* trust failures deny below */ }
        let postWaitIdle = false;
        // A missing/false/throwing idle proof is the fail-closed equivalent
        // of `context.isIdle?.() !== true`.
        try { postWaitIdle = context.isIdle?.() === true; } catch { /* idle failures deny below */ }
        const postWaitSnapshot = dependencies.mode.snapshot;
        const postWaitActiveFaculty = postWaitSnapshot.activeRun?.faculty;
        if (!postWaitTrusted) {
          deny("Godmode doctor apply refused: project trust changed while waiting; no files were changed.");
          return;
        }
        if (!postWaitIdle) {
          deny("Godmode doctor apply refused while the session is not affirmatively idle; no files were changed.");
          return;
        }
        if (postWaitActiveFaculty) {
          deny(`Godmode doctor apply refused while faculty ${postWaitActiveFaculty} became active; no files were changed.`);
          return;
        }
        const tokenCommand = command;
        // Construct effectful options solely from the post-wait proof. The
        // explicit null is required; pre-wait faculty state is never reused.
        const effectfulOptions: DoctorApplyOptions = { trusted: postWaitTrusted, activeFaculty: null, isIdle: postWaitIdle };
        const result = tokenCommand.action === "apply-confirm"
          ? (dependencies.applyPreview ?? ((root, token, options) => applyDoctorPreview(root, token, { ...options, ...(dependencies.doctorApplyManager ? { manager: dependencies.doctorApplyManager } : {}) })))(context.cwd, tokenCommand.token, effectfulOptions)
          : (dependencies.recoverPreview ?? ((root, token, options) => recoverDoctorPreview(root, token, { ...options, ...(dependencies.doctorApplyManager ? { manager: dependencies.doctorApplyManager } : {}) })))(context.cwd, tokenCommand.token, effectfulOptions);
        if (context.hasUI) context.ui.notify(result.rendered, result.status === "applied" || result.status === "recovered" ? "info" : "warning");
        else output(result.rendered);
      } catch (error) {
        deny(`Godmode doctor apply failed: ${error instanceof Error ? error.message : String(error)}; no files were changed.`);
      }
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
