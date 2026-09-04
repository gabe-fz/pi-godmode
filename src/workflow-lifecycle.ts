import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeForkEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  appendForkWorkflowSnapshot,
  captureForkSuccessorProof,
  LEDGER_CUSTOM_TYPE,
  reconstructActiveSnapshot,
  type ActiveSnapshot,
  type ForkSuccessorProof,
} from "./session-ledger.ts";
import type { LedgerRecoveryContext } from "./types.ts";
import { deriveChecklistView, type ChecklistView } from "./workflow-state.ts";

const MAX_WORKFLOW_BRANCH_ENTRIES = 1_024;

interface WorkflowIdentityDiscovery {
  workItemId?: string;
  reason?: string;
}

function discoverWorkflowIdentity(entries: readonly SessionEntry[]): WorkflowIdentityDiscovery {
  try {
    if (!Array.isArray(entries) || entries.length > MAX_WORKFLOW_BRANCH_ENTRIES) {
      return { reason: "Workflow branch exceeds the bounded recovery limit; recovery blocked." };
    }
    let discovered: string | undefined;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry || entry.type !== "custom" || entry.customType !== LEDGER_CUSTOM_TYPE) continue;
      const data = entry.data;
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return { reason: "Workflow ledger identity is malformed; recovery blocked." };
      }
      const workItemId = (data as { workItemId?: unknown }).workItemId;
      if (typeof workItemId !== "string" || workItemId.trim().length === 0) {
        return { reason: "Workflow ledger identity is malformed; recovery blocked." };
      }
      discovered ??= workItemId;
    }
    return { workItemId: discovered };
  } catch {
    return { reason: "Workflow ledger identity could not be read; recovery blocked." };
  }
}

/**
 * Find the validated inherited snapshot that the trusted fork lifecycle will
 * acknowledge. The append API performs the independent active-lineage check
 * again before writing; this helper only selects the seed for proof capture.
 */
function discoverInheritedWorkflowSnapshot(
  entries: readonly SessionEntry[],
  sessionId: string,
  workItemId: string,
  recoveryContext?: LedgerRecoveryContext,
): ActiveSnapshot | undefined {
  try {
    let inheritedSessionId: string | undefined;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry || entry.type !== "custom" || entry.customType !== LEDGER_CUSTOM_TYPE) continue;
      const data = entry.data;
      if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
      const raw = data as { workItemId?: unknown; sessionId?: unknown };
      if (raw.workItemId !== workItemId) continue;
      if (typeof raw.sessionId !== "string" || raw.sessionId.trim().length === 0) return undefined;
      if (raw.sessionId === sessionId) return undefined;
      if (inheritedSessionId !== undefined && inheritedSessionId !== raw.sessionId) return undefined;
      inheritedSessionId = raw.sessionId;
    }
    if (inheritedSessionId === undefined) return undefined;
    const inherited = reconstructActiveSnapshot(entries, inheritedSessionId, workItemId, recoveryContext);
    return inherited.status === "ok" ? inherited : undefined;
  } catch {
    return undefined;
  }
}

export interface WorkflowLifecycleOptions {
  /** Plain custom-entry append implementation supplied by the extension host. */
  pi: Pick<ExtensionAPI, "appendEntry">;
  setWorkflowView(view: Readonly<ChecklistView> | undefined): void;
  setWorkflowBlockedReason(reason: string | undefined): void;
  refresh(ctx: ExtensionContext): void;
  onContext?(ctx: ExtensionContext): void;
  now?(): string;
}

export interface WorkflowLifecycleHandlers {
  sessionStart(event: SessionStartEvent, ctx: ExtensionContext): void;
  sessionBeforeFork(event: SessionBeforeForkEvent, ctx: ExtensionContext): { cancel: true } | void;
  sessionTree(event: SessionTreeEvent, ctx: ExtensionContext): void;
  sessionShutdown(event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void> | void;
}

function managerFor(ctx: ExtensionContext) {
  return ctx.sessionManager;
}

/** Read only the current SessionManager header; the recovery routine hashes
 * the parent path and never persists this raw value. */
function recoveryContextFor(ctx: ExtensionContext): LedgerRecoveryContext | undefined {
  try {
    const header = ctx.sessionManager.getHeader();
    if (!header) return undefined;
    return {
      ...(typeof header.id === "string" ? { sessionId: header.id } : {}),
      ...(typeof header.parentSession === "string" ? { parentSessionFile: header.parentSession } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Focused session lifecycle component. It is deliberately independent of the
 * Godmode operational state, so lifecycle tests can invoke the exact handlers
 * registered by the extension without starting faculties or injecting context.
 */
export function createWorkflowLifecycle(options: WorkflowLifecycleOptions): WorkflowLifecycleHandlers {
  let pendingForkProof: ForkSuccessorProof | undefined;

  const clearState = (): void => {
    pendingForkProof = undefined;
    options.setWorkflowView(undefined);
    options.setWorkflowBlockedReason(undefined);
  };

  const block = (ctx: ExtensionContext, reason: string): void => {
    options.setWorkflowBlockedReason(reason);
    options.refresh(ctx);
  };

  const restoreWorkflow = (ctx: ExtensionContext, event?: SessionStartEvent): void => {
    clearState();

    let sessionId: string;
    let branch: readonly SessionEntry[];
    const recoveryContext = recoveryContextFor(ctx);
    try {
      sessionId = ctx.sessionManager.getSessionId();
      branch = ctx.sessionManager.getBranch();
    } catch {
      block(ctx, "Unable to read the active workflow branch; recovery blocked.");
      return;
    }
    const discovery = discoverWorkflowIdentity(branch);
    if (discovery.reason) {
      block(ctx, discovery.reason);
      return;
    }
    const workItemId = discovery.workItemId;
    if (!workItemId) {
      options.refresh(ctx);
      return;
    }

    let recovery = reconstructActiveSnapshot(branch, sessionId, workItemId, recoveryContext);
    if (event?.reason === "fork" && recovery.status === "blocked") {
      const inherited = discoverInheritedWorkflowSnapshot(branch, sessionId, workItemId, recoveryContext);
      let parentSessionFile: string | undefined;
      try {
        parentSessionFile = ctx.sessionManager.getHeader()?.parentSession;
      } catch {
        parentSessionFile = undefined;
      }
      pendingForkProof = inherited && captureForkSuccessorProof({
        reason: event.reason,
        previousSessionFile: event.previousSessionFile,
        parentSessionFile,
        sessionId,
        workItemId,
        inheritedEntryId: inherited.entryId,
        inheritedSnapshot: inherited.snapshot,
      });
      if (!inherited || !pendingForkProof) {
        block(ctx, recovery.reason);
        return;
      }
      try {
        // This is the only lifecycle write: the trusted proof authorizes one
        // plain custom successor and is consumed by the append operation.
        appendForkWorkflowSnapshot(
          options.pi,
          managerFor(ctx),
          inherited.snapshot.record,
          (options.now ?? (() => new Date().toISOString()))(),
          pendingForkProof,
        );
        pendingForkProof = undefined;
        branch = ctx.sessionManager.getBranch();
        recovery = reconstructActiveSnapshot(branch, sessionId, workItemId, recoveryContext);
      } catch (error) {
        pendingForkProof = undefined;
        block(ctx, `Fork workflow successor could not be persisted; recovery blocked: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    if (recovery.status === "ok") {
      options.setWorkflowView(deriveChecklistView(recovery.snapshot.record));
    } else if (recovery.status === "blocked") {
      options.setWorkflowBlockedReason(recovery.reason);
    }
    options.refresh(ctx);
  };

  const sessionStart = (event: SessionStartEvent, ctx: ExtensionContext): void => {
    options.onContext?.(ctx);
    restoreWorkflow(ctx, event);
  };

  const sessionBeforeFork = (event: SessionBeforeForkEvent, ctx: ExtensionContext): { cancel: true } | void => {
    options.onContext?.(ctx);
    pendingForkProof = undefined;
    try {
      const fullBranch = ctx.sessionManager.getBranch();
      const fullDiscovery = discoverWorkflowIdentity(fullBranch);
      if (fullDiscovery.reason) return { cancel: true };
      const selectedBranch = ctx.sessionManager.getBranch(event.entryId);
      const selectedDiscovery = discoverWorkflowIdentity(selectedBranch);
      if (selectedDiscovery.reason) return { cancel: true };
      if (fullDiscovery.workItemId && (!selectedDiscovery.workItemId || selectedDiscovery.workItemId !== fullDiscovery.workItemId)) {
        return { cancel: true };
      }
      if (!selectedDiscovery.workItemId) return;
      const recovery = reconstructActiveSnapshot(
        selectedBranch,
        ctx.sessionManager.getSessionId(),
        selectedDiscovery.workItemId,
        recoveryContextFor(ctx),
      );
      if (recovery.status === "blocked") return { cancel: true };
      if (recovery.status === "ok") options.setWorkflowView(deriveChecklistView(recovery.snapshot.record));
      options.refresh(ctx);
    } catch {
      return { cancel: true };
    }
  };

  const sessionTree = (_event: SessionTreeEvent, ctx: ExtensionContext): void => {
    options.onContext?.(ctx);
    restoreWorkflow(ctx);
  };

  const sessionShutdown = async (_event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void> => {
    options.onContext?.(ctx);
    clearState();
  };

  return { sessionStart, sessionBeforeFork, sessionTree, sessionShutdown };
}

/** Register all workflow lifecycle handlers as one bounded component. */
export function registerWorkflowLifecycle(
  pi: ExtensionAPI,
  options: Omit<WorkflowLifecycleOptions, "pi">,
): WorkflowLifecycleHandlers {
  const handlers = createWorkflowLifecycle({ ...options, pi });
  pi.on("session_start", handlers.sessionStart);
  pi.on("session_before_fork", handlers.sessionBeforeFork);
  pi.on("session_tree", handlers.sessionTree);
  pi.on("session_shutdown", handlers.sessionShutdown);
  return handlers;
}

