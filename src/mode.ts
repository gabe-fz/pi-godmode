import type { ModelLease, ModelLeaseHost } from "./model-lease.ts";
import { AmbiguousRpcOutcomeError, completionState, SubagentsClient } from "./subagents-client.ts";
import { extensionCapacityMs, hardDeadlineMs, launchBackstopMs, MAX_SUPERVISOR_EXTENSION_MS } from "./deadlines.ts";
import type { ActiveRun, DeadlineStatus, DelegationInput, Disposable, Faculty, GodmodeConfig, GodmodeSnapshot, TerminalRunState } from "./types.ts";
import { AGENT_NAMES, renderAssignment, validateDelegation } from "./faculties.ts";

export interface ModeDependencies {
  client: SubagentsClient;
  modelLease: ModelLease;
  modelHost: ModelLeaseHost;
  loadConfig(): Promise<GodmodeConfig>;
  isTrusted(): boolean;
  cwd(): string;
  sessionId(): string | undefined;
  validateFacultyModels(config: GodmodeConfig): Promise<void> | void;
  registerFaculties(config: GodmodeConfig): Disposable[];
  registerCeiling(sessionId: string): Disposable;
  preflight(config: GodmodeConfig): Promise<void>;
  acquireTools(): void;
  releaseTools(): void;
  onSnapshot?(snapshot: GodmodeSnapshot): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable timers keep deadline transitions deterministic in host tests. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  stopWaitMs?: number;
  pollMs?: number;
}

export class GodmodeMode {
  readonly #deps: ModeDependencies;
  #phase: GodmodeSnapshot["phase"] = "off";
  #active?: ActiveRun;
  #lastRun?: GodmodeSnapshot["lastRun"];
  #degradedReason?: string;
  #config?: GodmodeConfig;
  #registrations: Disposable[] = [];
  #ceiling?: Disposable;
  #toolsOwned = false;
  #completionUnsubscribe: () => void;
  #controlUnsubscribe: () => void;
  #softDeadlineTimer?: unknown;
  #hardDeadlineTimer?: unknown;
  /** Completion may beat the spawn RPC reply that supplies its correlation id. */
  #launchCompletions = new Map<string, unknown>();

  constructor(deps: ModeDependencies) {
    this.#deps = deps;
    this.#completionUnsubscribe = deps.client.onCompletion((payload) => this.#handleCompletion(payload));
    this.#controlUnsubscribe = deps.client.onControl((payload) => this.#handleControl(payload));
  }

  get config(): GodmodeConfig | undefined { return this.#config; }
  get snapshot(): GodmodeSnapshot {
    const delegation = this.#active?.phase ?? "idle";
    return {
      phase: this.#phase,
      delegation,
      ...(this.#active ? { activeRun: this.#snapshotActive(this.#active) } : {}),
      ...(this.#lastRun ? { lastRun: { ...this.#lastRun } } : {}),
      ...(this.#degradedReason ? { degradedReason: this.#degradedReason } : {}),
    };
  }

  #emit(): void { this.#deps.onSnapshot?.(this.snapshot); }

  markDegraded(reason: string): void {
    if (this.#phase === "active" || this.#phase === "degraded") this.#degrade(reason);
  }

  async enable(): Promise<void> {
    if (this.#phase !== "off") throw new Error(`Cannot enable Godmode while mode is ${this.#phase}.`);
    this.#phase = "enabling";
    this.#degradedReason = undefined;
    this.#lastRun = undefined;
    this.#emit();
    let leaseAcquired = false;
    try {
      if (!this.#deps.isTrusted()) throw new Error("Godmode requires a Pi-trusted project.");
      const config = await this.#deps.loadConfig();
      await this.#deps.client.ping();
      await this.#deps.validateFacultyModels(config);
      await this.#deps.modelLease.acquire(config, this.#deps.modelHost);
      leaseAcquired = true;
      this.#registrations = this.#deps.registerFaculties(config);
      const sessionId = this.#deps.sessionId();
      if (!sessionId) throw new Error("Godmode requires an active Pi session identity.");
      this.#ceiling = this.#deps.registerCeiling(sessionId);
      await this.#deps.preflight(config);
      this.#deps.acquireTools();
      this.#toolsOwned = true;
      this.#config = config;
      this.#phase = "active";
      this.#emit();
    } catch (error) {
      if (this.#toolsOwned) { try { this.#deps.releaseTools(); } catch { /* preserve original */ } this.#toolsOwned = false; }
      try { this.#ceiling?.dispose(); } catch { /* preserve original */ }
      this.#ceiling = undefined;
      for (const registration of this.#registrations.reverse()) { try { registration.dispose(); } catch { /* preserve original */ } }
      this.#registrations = [];
      if (leaseAcquired) { try { await this.#deps.modelLease.restore(this.#deps.modelHost); } catch { /* preserve original */ } }
      this.#config = undefined;
      this.#phase = "off";
      this.#active = undefined;
      this.#emit();
      throw error;
    }
  }

  async delegate(input: DelegationInput): Promise<{ runId: string; faculty: Faculty; agent: string; state: "queued" | "running" }> {
    if (this.#phase !== "active") throw new Error(`Godmode delegation requires healthy active mode; current mode is ${this.#phase}.`);
    if (this.#active) throw new Error(`Only one Divine Faculty may be active; ${this.#active.faculty} is ${this.#active.phase}.`);
    const config = this.#config;
    if (!config) throw new Error("Godmode configuration is unavailable.");
    const normalized = validateDelegation(input, this.#deps.cwd());
    const assignment = renderAssignment(normalized);
    const startedAt = (this.#deps.now ?? Date.now)();
    const softTimeoutMs = config.faculties[normalized.faculty].timeoutMs;
    const active: ActiveRun = {
      faculty: normalized.faculty,
      agent: AGENT_NAMES[normalized.faculty],
      title: normalized.title,
      assignment,
      phase: "launching",
      startedAt,
      deadline: {
        phase: "normal",
        softDeadlineAt: startedAt + softTimeoutMs,
        hardDeadlineAt: startedAt + hardDeadlineMs(softTimeoutMs),
        remainingMs: softTimeoutMs,
        hardRemainingMs: hardDeadlineMs(softTimeoutMs),
        checkpoint: "not_requested",
      },
    };
    this.#active = active;
    this.#lastRun = undefined;
    this.#emit();
    try {
      const receipt = await this.#deps.client.spawn({
        agent: active.agent,
        task: assignment,
        cwd: this.#deps.cwd(),
        config: config.faculties[normalized.faculty],
        timeoutMs: launchBackstopMs(softTimeoutMs),
      });
      if (this.#active !== active) throw new Error("Godmode active slot changed during faculty launch; refusing ambiguous ownership.");
      active.runId = receipt.runId;
      const earlyCompletion = this.#launchCompletions.get(receipt.runId);
      this.#launchCompletions.clear();
      if (earlyCompletion !== undefined) {
        this.#handleCompletion(earlyCompletion);
      } else {
        active.phase = "running";
        this.#scheduleDeadlineTimers(active);
        this.#emit();
      }
      return { runId: receipt.runId, faculty: normalized.faculty, agent: active.agent, state: receipt.state };
    } catch (error) {
      if (this.#active === active) {
        if (error instanceof AmbiguousRpcOutcomeError) {
          this.#degrade(`Faculty launch outcome is uncertain; the active slot remains reserved: ${error.message}`);
        } else {
          this.#active = undefined;
          this.#emit();
        }
      }
      this.#launchCompletions.clear();
      throw error;
    }
  }

  async status(): Promise<GodmodeSnapshot> {
    const active = this.#active;
    if (!active?.runId) return this.snapshot;
    try {
      const status = await this.#deps.client.status(active.runId);
      if (this.#active !== active) return this.snapshot;
      if (status.state === "needs_attention") {
        if (active.deadline?.phase !== "hard" && active.phase !== "stopping") active.phase = "attention";
      } else if (status.state === "queued" || status.state === "running") {
        if (active.deadline?.phase !== "hard" && active.phase !== "stopping") active.phase = "running";
      } else if (status.state === "stopping") active.phase = "stopping";
      else this.#finish(active, status.state, status.raw);
      this.#emit();
      return this.snapshot;
    } catch (error) {
      if (this.#active !== active && this.#lastRun?.runId === active.runId) return this.snapshot;
      this.#degrade(`Status reconciliation failed closed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async steer(message: string): Promise<GodmodeSnapshot> {
    const normalized = message.trim();
    if (!normalized) throw new Error("Steering message must be nonempty.");
    if (Buffer.byteLength(normalized, "utf8") > 32 * 1024) throw new Error("Steering message exceeds 32 KiB.");
    const active = this.#active;
    if (!active?.runId) throw new Error("No active Divine Faculty is available to steer.");
    if (active.phase === "stopping") throw new Error("Cannot steer a stopping Divine Faculty.");
    try {
      await this.#deps.client.steer(active.runId, normalized);
    } catch (error) {
      if (this.#active !== active && this.#lastRun?.runId === active.runId) return this.snapshot;
      throw error;
    }
    if (this.#active === active && active.phase === "attention") active.phase = "running";
    this.#emit();
    return this.snapshot;
  }

  async stop(reason?: string): Promise<GodmodeSnapshot> {
    if (reason !== undefined && Buffer.byteLength(reason.trim(), "utf8") > 4 * 1024) throw new Error("Stop reason exceeds 4 KiB.");
    const active = this.#active;
    if (!active?.runId) throw new Error("No active Divine Faculty is available to stop.");
    active.phase = "stopping";
    this.#emit();
    try {
      await this.#deps.client.stop(active.runId, reason);
      return this.snapshot;
    } catch (error) {
      if (this.#active !== active && this.#lastRun?.runId === active.runId) return this.snapshot;
      this.#degrade(`Stop request failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Grant one explicit, bounded grace period after the soft deadline. This is
   * intentionally supervisor-driven: a run can never extend itself or renew
   * its deadline indefinitely.
   */
  async extend(extensionMs: number): Promise<GodmodeSnapshot> {
    if (!Number.isInteger(extensionMs) || extensionMs < 1 || extensionMs > MAX_SUPERVISOR_EXTENSION_MS) {
      throw new Error(`Deadline extension must be an integer from 1 to ${MAX_SUPERVISOR_EXTENSION_MS}ms.`);
    }
    const active = this.#active;
    if (!active?.runId || !active.deadline) throw new Error("No active Divine Faculty is available to extend.");
    if (active.phase === "stopping") throw new Error("Cannot extend a stopping Divine Faculty.");
    if (active.deadline.extensionMs !== undefined) throw new Error("Only one deadline extension may be granted per faculty run.");
    if (active.deadline.phase !== "pending") throw new Error("A deadline extension is available only after the soft deadline is pending.");
    if ((this.#deps.now ?? Date.now)() >= active.deadline.hardDeadlineAt) throw new Error("The hard deadline has elapsed; the faculty can no longer be extended.");
    const softTimeoutMs = active.deadline.softDeadlineAt - active.startedAt;
    const capacityMs = extensionCapacityMs(softTimeoutMs);
    if (extensionMs > capacityMs) {
      throw new Error(`Deadline extension exceeds the ${capacityMs}ms reserved by this faculty's immutable launch backstop.`);
    }
    active.deadline.hardDeadlineAt += extensionMs;
    active.deadline.extensionMs = extensionMs;
    active.deadline.phase = "extended";
    this.#scheduleHardDeadlineTimer(active);
    this.#emit();
    return this.snapshot;
  }

  async disable(options: { stopActive?: boolean } = {}): Promise<void> {
    if (this.#phase === "off") return;
    if (this.#phase === "enabling") throw new Error("Cannot disable Godmode while enable is in progress.");
    if (this.#active && !options.stopActive) throw new Error("A Divine Faculty is active; explicit stop-and-disable confirmation is required.");
    this.#phase = "stopping";
    this.#emit();
    if (this.#active) {
      try {
        if (this.#active.phase !== "stopping") await this.stop();
        await this.#waitForTerminal();
      } catch (error) {
        this.#degrade(`Disable cleanup could not prove terminal faculty status: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }
    const cleanupErrors: Error[] = [];
    try { this.#ceiling?.dispose(); } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
    this.#ceiling = undefined;
    for (const registration of this.#registrations.reverse()) {
      try { registration.dispose(); } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
    }
    this.#registrations = [];
    if (this.#toolsOwned) {
      try { this.#deps.releaseTools(); } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
      this.#toolsOwned = false;
    }
    try { await this.#deps.modelLease.restore(this.#deps.modelHost); } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error(String(error))); }
    this.#config = undefined;
    this.#clearDeadlineTimers();
    this.#launchCompletions.clear();
    this.#active = undefined;
    this.#lastRun = undefined;
    this.#degradedReason = undefined;
    this.#phase = cleanupErrors.length ? "degraded" : "off";
    this.#emit();
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Godmode disabled with cleanup errors.");
  }

  async shutdown(): Promise<void> {
    if (this.#phase !== "off") {
      if (this.#active?.runId) {
        try { if (this.#active.phase !== "stopping") await this.stop(); } catch { /* best effort on host shutdown */ }
      }
      try { this.#ceiling?.dispose(); } catch { /* shutdown */ }
      for (const registration of this.#registrations.reverse()) { try { registration.dispose(); } catch { /* shutdown */ } }
      if (this.#toolsOwned) { try { this.#deps.releaseTools(); } catch { /* shutdown */ } }
      try { await this.#deps.modelLease.restore(this.#deps.modelHost); } catch { /* host may no longer permit model mutation */ }
      this.#phase = "off";
      this.#clearDeadlineTimers();
      this.#launchCompletions.clear();
      this.#active = undefined;
      this.#config = undefined;
      this.#emit();
    }
    this.#completionUnsubscribe();
    this.#controlUnsubscribe();
  }

  #snapshotActive(active: ActiveRun): Readonly<ActiveRun> {
    return {
      ...active,
      ...(active.deadline ? { deadline: this.#snapshotDeadline(active.deadline) } : {}),
    };
  }

  #snapshotDeadline(deadline: DeadlineStatus): DeadlineStatus {
    const now = (this.#deps.now ?? Date.now)();
    return {
      ...deadline,
      remainingMs: Math.max(0, deadline.softDeadlineAt - now),
      hardRemainingMs: Math.max(0, deadline.hardDeadlineAt - now),
    };
  }

  #setTimer(callback: () => void, ms: number): unknown {
    const timer = (this.#deps.setTimer ?? ((handler, delay) => setTimeout(handler, delay)))(callback, Math.max(0, ms));
    // Deadline timers should not keep a shutting-down/test process alive.
    const unref = (timer as { unref?: () => void } | undefined)?.unref;
    if (typeof unref === "function") unref.call(timer);
    return timer;
  }

  #clearTimer(timer: unknown): void {
    if (timer === undefined) return;
    if (this.#deps.clearTimer) this.#deps.clearTimer(timer);
    else clearTimeout(timer as ReturnType<typeof setTimeout>);
  }

  #clearDeadlineTimers(): void {
    this.#clearTimer(this.#softDeadlineTimer);
    this.#clearTimer(this.#hardDeadlineTimer);
    this.#softDeadlineTimer = undefined;
    this.#hardDeadlineTimer = undefined;
  }

  #scheduleDeadlineTimers(active: ActiveRun): void {
    this.#clearDeadlineTimers();
    if (!active.deadline) return;
    const now = (this.#deps.now ?? Date.now)();
    this.#softDeadlineTimer = this.#setTimer(() => this.#handleSoftDeadline(active), active.deadline.softDeadlineAt - now);
    this.#hardDeadlineTimer = this.#setTimer(() => this.#handleHardDeadline(active), active.deadline.hardDeadlineAt - now);
  }

  #scheduleHardDeadlineTimer(active: ActiveRun): void {
    this.#clearTimer(this.#hardDeadlineTimer);
    this.#hardDeadlineTimer = undefined;
    if (!active.deadline) return;
    const now = (this.#deps.now ?? Date.now)();
    this.#hardDeadlineTimer = this.#setTimer(() => this.#handleHardDeadline(active), active.deadline.hardDeadlineAt - now);
  }

  #handleSoftDeadline(active: ActiveRun): void {
    this.#softDeadlineTimer = undefined;
    if (this.#active !== active || !active.runId || !active.deadline || active.phase === "stopping" || active.deadline.phase !== "normal") return;
    active.deadline.phase = "pending";
    active.deadline.checkpoint = "pending";
    active.deadline.checkpointRequestedAt = (this.#deps.now ?? Date.now)();
    this.#emit();
    void this.#requestCheckpoint(active);
  }

  async #requestCheckpoint(active: ActiveRun): Promise<void> {
    if (!active.runId) return;
    const message = "Godmode soft deadline reached. After the current tool returns, checkpoint now: report changed files, build/test state, remaining work, and any unresolved decision. Continue only within the approved assignment; do not expand scope while the Primary considers the deadline.";
    try {
      await this.#deps.client.steer(active.runId, message, "follow_up");
      if (this.#active === active && (active.deadline?.phase === "pending" || active.deadline?.phase === "extended")) {
        if (active.deadline.checkpoint === "pending") active.deadline.checkpoint = "requested";
        this.#emit();
      }
    } catch {
      if (this.#active !== active || !active.deadline) return;
      active.deadline.checkpoint = "failed";
      this.#emit();
      // The hard timer remains authoritative. Preserve the active slot and
      // let the Primary decide whether to extend or stop the unresolved run.
    }
  }

  #handleHardDeadline(active: ActiveRun): void {
    this.#hardDeadlineTimer = undefined;
    if (this.#active !== active || !active.runId || !active.deadline || active.phase === "stopping") return;
    active.deadline.phase = "hard";
    active.phase = "stopping";
    this.#emit();
    void this.#requestHardStop(active);
  }

  async #requestHardStop(active: ActiveRun): Promise<void> {
    if (!active.runId) return;
    try {
      await this.#deps.client.stop(active.runId, "Godmode hard deadline reached before the Faculty produced a terminal result.");
    } catch (error) {
      if (this.#active !== active && this.#lastRun?.runId === active.runId) return;
      this.#degrade(`Hard deadline stop request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #finish(active: ActiveRun, state: TerminalRunState, result: unknown): void {
    if (this.#active !== active || !active.runId) return;
    this.#clearDeadlineTimers();
    if (state === "timed_out" && active.deadline) active.deadline.phase = "hard";
    this.#lastRun = {
      runId: active.runId,
      faculty: active.faculty,
      state,
      ...(active.deadline ? { deadline: this.#snapshotDeadline(active.deadline) } : {}),
      result,
    };
    this.#active = undefined;
  }

  #handleCompletion(payload: unknown): void {
    const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    const runId = typeof value?.runId === "string" ? value.runId : typeof value?.id === "string" ? value.id : undefined;
    if (!runId) return;
    if (this.#lastRun?.runId === runId) return;
    const active = this.#active;
    if (active?.phase === "launching" && !active.runId) {
      this.#launchCompletions.set(runId, payload);
      if (this.#launchCompletions.size > 32) {
        const oldest = this.#launchCompletions.keys().next().value as string | undefined;
        if (oldest !== undefined) this.#launchCompletions.delete(oldest);
      }
      return;
    }
    if (!active?.runId || active.runId !== runId) return;
    const state = completionState(payload);
    if (state === "needs_attention" && active.deadline?.phase !== "hard") active.phase = "attention";
    else if (state !== "needs_attention") this.#finish(active, state, payload);
    this.#emit();
  }

  #handleControl(payload: unknown): void {
    const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    const active = this.#active;
    if (!active?.runId || value?.runId !== active.runId) return;
    if ((value.to === "needs_attention" || value.type === "needs_attention") && active.deadline?.phase !== "hard") active.phase = "attention";
    else if (active.phase === "attention" && active.deadline?.phase !== "hard") active.phase = "running";
    this.#emit();
  }

  #degrade(reason: string): void {
    this.#phase = "degraded";
    this.#degradedReason = reason;
    this.#emit();
  }

  async #waitForTerminal(): Promise<void> {
    const deadline = (this.#deps.now ?? Date.now)() + (this.#deps.stopWaitMs ?? 20_000);
    const sleep = this.#deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    while (this.#active) {
      if ((this.#deps.now ?? Date.now)() >= deadline) throw new Error("Timed out waiting for terminal pi-subagents lifecycle status.");
      await sleep(this.#deps.pollMs ?? 200);
      if (!this.#active) return;
      await this.status();
    }
  }
}
