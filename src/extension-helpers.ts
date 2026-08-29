import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

type GodmodeToggleMode = Pick<GodmodeMode, "snapshot" | "enable" | "disable">;

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
