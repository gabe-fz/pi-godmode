import type { ModelLease, ModelLeaseHost } from "./model-lease.ts";
import { AmbiguousRpcOutcomeError, completionState, SubagentsClient } from "./subagents-client.ts";
import type { ActiveRun, DelegationInput, Disposable, Faculty, GodmodeConfig, GodmodeSnapshot, TerminalRunState } from "./types.ts";
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
      ...(this.#active ? { activeRun: { ...this.#active } } : {}),
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
    const active: ActiveRun = {
      faculty: normalized.faculty,
      agent: AGENT_NAMES[normalized.faculty],
      title: normalized.title,
      assignment,
      phase: "launching",
      startedAt: (this.#deps.now ?? Date.now)(),
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
      });
      if (this.#active !== active) throw new Error("Godmode active slot changed during faculty launch; refusing ambiguous ownership.");
      active.runId = receipt.runId;
      active.phase = "running";
      this.#emit();
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
      throw error;
    }
  }

  async status(): Promise<GodmodeSnapshot> {
    const active = this.#active;
    if (!active?.runId) return this.snapshot;
    try {
      const status = await this.#deps.client.status(active.runId);
      if (this.#active !== active) return this.snapshot;
      if (status.state === "needs_attention") active.phase = "attention";
      else if (status.state === "queued" || status.state === "running") active.phase = "running";
      else if (status.state === "stopping") active.phase = "stopping";
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
      this.#active = undefined;
      this.#config = undefined;
      this.#emit();
    }
    this.#completionUnsubscribe();
    this.#controlUnsubscribe();
  }

  #finish(active: ActiveRun, state: TerminalRunState, result: unknown): void {
    if (this.#active !== active || !active.runId) return;
    this.#lastRun = { runId: active.runId, faculty: active.faculty, state, result };
    this.#active = undefined;
  }

  #handleCompletion(payload: unknown): void {
    const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    const runId = typeof value?.runId === "string" ? value.runId : typeof value?.id === "string" ? value.id : undefined;
    if (!runId) return;
    if (this.#lastRun?.runId === runId) return;
    const active = this.#active;
    if (!active?.runId || active.runId !== runId) return;
    const state = completionState(payload);
    if (state === "needs_attention") active.phase = "attention";
    else this.#finish(active, state, payload);
    this.#emit();
  }

  #handleControl(payload: unknown): void {
    const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    const active = this.#active;
    if (!active?.runId || value?.runId !== active.runId) return;
    if (value.to === "needs_attention" || value.type === "needs_attention") active.phase = "attention";
    else if (active.phase === "attention") active.phase = "running";
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
