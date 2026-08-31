import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ActiveToolLease } from "./active-tools.ts";
import { registerFaculties } from "./agents.ts";
import { DEFAULT_CEILING_REGISTRAR } from "./ceiling.ts";
import { loadConfig } from "./config.ts";
import { initializeGodmodeSession, toggleGodmodeTui } from "./extension-helpers.ts";
import { GodmodeMode } from "./mode.ts";
import { ModelLease, type PiModel } from "./model-lease.ts";
import { mutationGuard } from "./mutation-guard.ts";
import { preflightFaculties } from "./preflight.ts";
import { statusLine, boundedStatus } from "./status.ts";
import { SubagentsClient } from "./subagents-client.ts";
import { registerGodmodeTools } from "./tools.ts";
import type { GodmodeConfig, ThinkingLevel } from "./types.ts";

export const PRIMARY_GUIDANCE_VERSION = 5;
export const PRIMARY_GUIDANCE = `Godmode is active. You are the high-tier Primary and the sole planning, decision, orchestration, review, acceptance, and user-facing authority. Do not delegate authority or seek an oracle. Delegate bounded reconnaissance to Eye, implementation to Hand, and independent review to Scale. Only one Divine Faculty may be active.

Give each Faculty a fresh standalone assignment with its goal, approved behavior, starting context, constraints, validation expectations, and escalation rules. Faculties execute; they do not decide product scope, architecture authority, security policy, version control, release actions, or acceptance. Answer material supervisor questions rather than allowing a Faculty to guess.

Faculty runs complete asynchronously; automatic completion delivery is the default. After delegation, do not independently repeat or continue the Faculty's assigned work while it is active. Return control and wait for automatic completion, except to answer material supervisor questions or handle an explicit user interruption. Never call godmode_control status merely to check whether a queued or running faculty has finished. Do not call subagent_wait or poll with short timeouts. Use godmode_control status only when the user explicitly requests a snapshot, when recovering unknown session state, or when diagnosing a genuinely missing completion or inconsistent state. Repeated status calls waste tokens.

A configured faculty timeout is a soft deadline, not an immediate kill. When deadline-pending status appears, let the Faculty checkpoint after its current tool and grant at most one bounded extension through godmode_control only when warranted; the finite hard deadline remains authoritative.

Do not mutate the shared checkout while Hand is active. A Faculty handoff is evidence, not completion. After Hand returns, inspect the complete diff and all materially changed files, independently run required validation, resolve any Scale findings, and only then report the task complete.`;

const THINKING_RANK: Record<ThinkingLevel, number> = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

function modelKey(model: { provider: string; id: string }): string { return `${model.provider}/${model.id}`; }

type ScopedModel = { model: { provider: string; id: string }; thinkingLevel?: string };
function scopedModels(ctx: ExtensionContext): readonly ScopedModel[] {
  return ((ctx as unknown as { scopedModels?: readonly ScopedModel[] }).scopedModels ?? []);
}

export default function godmodeExtension(pi: ExtensionAPI): void {
  let currentCtx: ExtensionContext | undefined;
  const client = new SubagentsClient(pi.events);
  const modelLease = new ModelLease();
  const toolLease = new ActiveToolLease(pi);
  let verifiedGodmodeModels = new Set<string>();

  const requireContext = (): ExtensionContext => {
    if (!currentCtx) throw new Error("Godmode has no active Pi session context.");
    return currentCtx;
  };

  const modelHost = {
    findModel(provider: string, id: string): PiModel | undefined {
      return requireContext().modelRegistry.find(provider, id) as PiModel | undefined;
    },
    isModelScoped(model: PiModel): boolean {
      const scoped = scopedModels(requireContext());
      const inScope = scoped.length === 0 || scoped.some((entry) => entry.model.provider === model.provider && entry.model.id === model.id);
      return inScope && (verifiedGodmodeModels.size === 0 || verifiedGodmodeModels.has(modelKey(model)));
    },
    setModel(model: PiModel): Promise<boolean> { return pi.setModel(model as unknown as Parameters<typeof pi.setModel>[0]); },
    getModel(): PiModel | undefined { return requireContext().model as PiModel | undefined; },
    getThinkingLevel(): ThinkingLevel { return pi.getThinkingLevel() as ThinkingLevel; },
    setThinkingLevel(level: ThinkingLevel): void { pi.setThinkingLevel(level); },
  };

  const mode = new GodmodeMode({
    client,
    modelLease,
    modelHost,
    loadConfig,
    isTrusted: () => requireContext().isProjectTrusted(),
    cwd: () => realpathSync(requireContext().cwd),
    sessionId: () => requireContext().sessionManager.getSessionFile() ?? requireContext().sessionManager.getSessionId(),
    async validateFacultyModels(config: GodmodeConfig) {
      const ctx = requireContext();
      const available = new Set(ctx.modelRegistry.getAvailable().map(modelKey));
      const scopedEntries = scopedModels(ctx);
      const scoped = scopedEntries.length === 0 ? undefined : new Set(scopedEntries.map((entry) => modelKey(entry.model)));
      const check = async (tuple: { provider: string; model: string }): Promise<string | undefined> => {
        const key = `${tuple.provider}/${tuple.model}`;
        const model = ctx.modelRegistry.find(tuple.provider, tuple.model);
        if (!model || !available.has(key)) return `${key}: unavailable or unauthenticated`;
        if (scoped && !scoped.has(key)) return `${key}: outside the active Pi model scope`;
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        return auth.ok ? undefined : `${key}: authentication failed (${auth.error})`;
      };
      verifiedGodmodeModels = new Set<string>();
      const godmodeFailures: string[] = [];
      for (const tuple of config.godmodePolicy.allowedModels) {
        const failure = await check(tuple);
        if (failure) godmodeFailures.push(failure);
        else verifiedGodmodeModels.add(`${tuple.provider}/${tuple.model}`);
      }
      if (godmodeFailures.length === config.godmodePolicy.allowedModels.length) {
        throw new Error(`No configured Godmode model is available: ${godmodeFailures.join("; ")}.`);
      }
      for (const [name, tuple] of Object.entries(config.faculties)) {
        const failure = await check(tuple);
        if (failure) throw new Error(`${name} faculty model is unavailable: ${failure}.`);
      }
    },
    registerFaculties: (config) => registerFaculties(pi.events, config),
    registerCeiling: (sessionId) => DEFAULT_CEILING_REGISTRAR.register(sessionId),
    preflight: async (config) => {
      const ctx = requireContext();
      await preflightFaculties({
        config,
        cwd: ctx.cwd,
        availableModels: ctx.modelRegistry.getAvailable(),
        ...(ctx.model ? { parentModel: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
        runtimeRegistrationVerified: true,
      });
    },
    acquireTools: () => toolLease.acquire(),
    releaseTools: () => toolLease.release(),
    onSnapshot: (snapshot) => {
      if (!currentCtx?.hasUI) return;
      currentCtx.ui.setStatus("godmode", statusLine(snapshot));
    },
  });

  registerGodmodeTools(pi, mode);

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    await initializeGodmodeSession(mode, pi, ctx);
  });

  pi.registerCommand("godmode", {
    description: "Toggle constrained Godmode orchestration",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      if (args.trim()) { ctx.ui.notify("Usage: /godmode", "warning"); return; }
      if (ctx.mode !== "tui") {
        const report = JSON.stringify(boundedStatus(mode.snapshot));
        if (ctx.hasUI) ctx.ui.notify(report, "info");
        else console.log(report);
        return;
      }
      await toggleGodmodeTui(mode, ctx);
    },
  });

  pi.on("before_agent_start", (event) => {
    if (mode.snapshot.phase !== "active" && mode.snapshot.phase !== "degraded") return;
    return { systemPrompt: `${event.systemPrompt}\n\n[Pi Godmode guidance v${PRIMARY_GUIDANCE_VERSION}]\n${PRIMARY_GUIDANCE}` };
  });

  pi.on("tool_call", (event) => {
    const snapshot = mode.snapshot;
    if (snapshot.phase === "active" || snapshot.phase === "degraded") {
      if (event.toolName === "subagent") return { block: true, reason: "Godmode replaces arbitrary subagent execution with godmode_delegate." };
      if (event.toolName === "subagent_wait") return { block: true, reason: "Godmode delivers faculty completion asynchronously; do not poll or wait with subagent_wait." };
    }
    return mutationGuard(event.toolName, snapshot);
  });

  pi.on("model_select", (event) => {
    const config = mode.config;
    if (!config || mode.snapshot.phase !== "active") return;
    const allowed = config.godmodePolicy.allowedModels.some((tuple) => tuple.provider === event.model.provider && tuple.model === event.model.id);
    if (!allowed) {
      mode.markDegraded(`Primary model changed outside the configured Godmode allowlist to ${event.model.provider}/${event.model.id}.`);
      currentCtx?.ui.notify("Godmode degraded: Primary model left the Godmode allowlist. Disable Godmode to restore the lease.", "error");
    }
  });

  pi.on("thinking_level_select", (event) => {
    const config = mode.config;
    if (!config || mode.snapshot.phase !== "active") return;
    if (THINKING_RANK[event.level as ThinkingLevel] < THINKING_RANK[config.godmodePolicy.minimumThinking]) {
      mode.markDegraded(`Primary thinking changed below configured minimum ${config.godmodePolicy.minimumThinking}.`);
      currentCtx?.ui.notify("Godmode degraded: Primary thinking fell below the configured minimum.", "error");
    }
  });

  pi.on("session_shutdown", async () => {
    await mode.shutdown();
    currentCtx = undefined;
  });
}
