import { randomBytes } from "node:crypto";
import { statSync, watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ModelLease, ModelLeaseHost } from "./model-lease.ts";
import { AmbiguousRpcOutcomeError, completionState, SubagentsClient } from "./subagents-client.ts";
import { extensionCapacityMs, hardDeadlineMs, launchBackstopMs, MAX_SUPERVISOR_EXTENSION_MS } from "./deadlines.ts";
import type { ActiveRun, DeadlineStatus, DelegationInput, Disposable, Faculty, GodmodeConfig, GodmodeSnapshot, PrimaryInspection, ScaleAdmission, TerminalRunState, WorkflowPhase, WorkflowRecord } from "./types.ts";
import { validateScaleAdmission } from "./workflow-state.ts";
import { AGENT_NAMES, renderAssignment, validateDelegation, validateHandAdmission, verifyRedTestIdentity, type HandAdmissionBinding } from "./faculties.ts";
import { inspectionArtifactContextPaths, readInspectionArtifactForContext, verifyInspectionArtifacts as verifyCapturedInspectionArtifacts } from "./inspection-artifacts.ts";

export interface RedTestMonitor extends Disposable {
  /** Optional externally observable sticky state for deterministic hosts. */
  isCompromised?(): boolean;
}

export type RedTestMonitorFactory = (
  identity: { path: string; hash: string },
  onEvent: () => void,
) => RedTestMonitor;

function createDefaultScaleAdmission(record: WorkflowRecord): ScaleAdmission {
  const nonce = randomBytes(32).toString("hex");
  const inspection = record.primaryInspection;
  if (!inspection) throw new Error("Scale admission requires a complete Primary inspection.");
  return {
    admissionId: `scale-admission-${nonce}`,
    nonce,
    workItemId: record.workItemId,
    inspectionId: inspection.id,
    diffFingerprint: inspection.diffFingerprint,
    admittedAt: new Date().toISOString(),
  };
}

function defaultRedTestMonitor(cwd: string, identity: { path: string; hash: string }, onEvent: () => void): RedTestMonitor {
  const absolute = resolve(cwd, identity.path);
  const target = basename(absolute);
  const initial = statSync(absolute);
  const watchers: Array<{ close(): void }> = [];
  let disposed = false;
  let sticky = false;
  const mark = (): void => {
    if (disposed) return;
    sticky = true;
    onEvent();
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const watcher of watchers.splice(0)) {
      try { watcher.close(); } catch { /* cleanup is best effort */ }
    }
  };
  try {
    // A file watcher catches writes and renames/removals of the admitted file.
    // The parent watcher catches replacement via rename without treating
    // unrelated sibling files as a compromise.
    watchers.push(watch(absolute, { persistent: false }, () => mark()));
    watchers.push(watch(dirname(absolute), { persistent: false }, (_event, filename) => {
      const name = filename === undefined || filename === null ? undefined : filename.toString();
      if (name === target) mark();
    }));
  } catch (error) {
    dispose();
    throw new Error(`Unable to monitor the immutable red test: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    dispose,
    isCompromised(): boolean {
      if (sticky) return true;
      try {
        const current = statSync(absolute);
        // A synchronous metadata check closes the small ordering window where
        // a write/restore event is queued by fs.watch just before completion.
        if (current.dev !== initial.dev || current.ino !== initial.ino || current.size !== initial.size
          || current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs) sticky = true;
      } catch {
        sticky = true;
      }
      return sticky;
    },
  };
}

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
  /** Internal canonical ledger access; absent or malformed state blocks Hand. */
  getWorkflowRecord?: () => WorkflowRecord | undefined;
  /** Compatibility spelling for internal lifecycle wiring and focused hosts. */
  workflowRecord?: () => WorkflowRecord | undefined;
  /** Trusted Primary-owned append/transition callback. It must update the
   * canonical in-memory record only after appendWorkflowSnapshot acknowledges. */
  persistWorkflowTransition?(to: WorkflowPhase, reason: string, reference: string): WorkflowRecord;
  /** Synchronous seam for the immutable red-test monitor. */
  monitorRedTest?: RedTestMonitorFactory;
  /** Trusted Scale lifecycle callbacks. Admission is persisted before spawn;
   * binding is persisted after the host acknowledges the run ID. */
  createScaleAdmission?(record: WorkflowRecord): ScaleAdmission;
  persistScaleAdmission?(admission: ScaleAdmission): WorkflowRecord;
  bindScaleAdmission?(admissionId: string, runId: string): WorkflowRecord;
  /** Reverify captured inspection artifacts and the live checkout at admission. */
  verifyInspectionArtifacts?(cwd: string, inspection: PrimaryInspection): boolean;
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
  #activeHandRedIdentity?: NonNullable<HandAdmissionBinding["redTest"]>;
  #activeHandRedMonitor?: RedTestMonitor;
  #activeHandRedCompromised = false;

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
    if ((input.faculty === "hand" || input.faculty === "scale") && !this.#deps.persistWorkflowTransition) {
      throw new Error(`${input.faculty === "hand" ? "Hand" : "Scale"} admission requires trusted workflow lifecycle persistence.`);
    }
    const canonicalRecord = input.faculty === "hand" || input.faculty === "scale" ? this.#readWorkflowRecord() : undefined;
    let scaleAdmission: ScaleAdmission | undefined;
    if (input.faculty === "scale") {
      if (!canonicalRecord) throw new Error("Scale admission requires canonical workflow state; absent state is blocked.");
      const inspection = canonicalRecord.primaryInspection;
      if (!inspection) throw new Error("Scale admission requires a complete current Primary inspection.");
      const verify = this.#deps.verifyInspectionArtifacts ?? ((cwd: string, value: PrimaryInspection) => verifyCapturedInspectionArtifacts(cwd, value));
      if (!verify(this.#deps.cwd(), inspection)) throw new Error("Scale admission requires fresh, untampered inspection artifacts and an unchanged checkout.");
      const artifactPaths = inspectionArtifactContextPaths(inspection);
      if (artifactPaths.length < 2
        || !readInspectionArtifactForContext(inspection.statusReference, "git-status")
        || !readInspectionArtifactForContext(inspection.completeDiffReference, "git-complete-diff")) {
        throw new Error("Scale admission requires readable bounded status and complete-diff artifacts.");
      }
      const inspectionPaths = [...new Set([
        ...inspection.materiallyChangedPaths,
        ...inspection.outOfScopeChanges.map((change) => change.path),
      ])];
      // The Primary may provide additional context, but cannot omit any
      // materially changed or investigated out-of-scope checkout path or
      // either trusted artifact source from the independent assignment.
      input = {
        ...input,
        contextFiles: [...new Set([...(input.contextFiles ?? []), ...artifactPaths])],
        expectedPaths: [...new Set([...(input.expectedPaths ?? []), ...inspectionPaths])],
      };
      const createAdmission = this.#deps.createScaleAdmission ?? createDefaultScaleAdmission;
      scaleAdmission = createAdmission(canonicalRecord);
      if (!validateScaleAdmission(scaleAdmission, canonicalRecord.workItemId, inspection)) {
        throw new Error("Trusted Scale admission callback returned malformed or stale admission data.");
      }
      if (!this.#deps.persistScaleAdmission || !this.#deps.bindScaleAdmission) {
        throw new Error("Scale admission requires trusted create/persist/bind lifecycle callbacks.");
      }
    }
    const normalized = validateDelegation(input, this.#deps.cwd(), canonicalRecord);
    const handBinding = input.faculty === "hand"
      ? validateHandAdmission(normalized, this.#deps.cwd(), canonicalRecord)
      : undefined;
    const assignment = renderAssignment(normalized, input.faculty === "hand" || input.faculty === "scale" ? canonicalRecord : undefined);
    const startedAt = (this.#deps.now ?? Date.now)();
    const softTimeoutMs = config.faculties[normalized.faculty].timeoutMs;
    const active: ActiveRun = {
      ...(scaleAdmission !== undefined ? { admissionId: scaleAdmission.admissionId } : {}),
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
    this.#activeHandRedIdentity = handBinding?.redTest;
    this.#activeHandRedCompromised = false;
    this.#lastRun = undefined;
    this.#emit();
    try {
      if (normalized.faculty === "hand") {
        // Reserve the workflow slot in the ledger before any child can mutate
        // the shared checkout. This callback is trusted extension plumbing;
        // no model-facing input can select its actor or target phase.
        this.#persistWorkflowPhase(active, "hand-running", "Primary admitted Hand after the immutable red-test/TDD gate.", "workflow:hand-running");
        if (this.#activeHandRedIdentity) {
          const identity = this.#activeHandRedIdentity;
          const markCompromised = (): void => {
            if (this.#active === active) this.#activeHandRedCompromised = true;
          };
          this.#activeHandRedMonitor = (this.#deps.monitorRedTest
            ?? ((redIdentity, onEvent) => defaultRedTestMonitor(this.#deps.cwd(), redIdentity, onEvent)))(identity, markCompromised);
        }
      } else if (normalized.faculty === "scale") {
        // Persist the complete admission before spawn. A failed lifecycle
        // append or a missing trusted callback must not leave an apparently
        // reviewable run.
        const persisted = this.#deps.persistScaleAdmission!(scaleAdmission!);
        if (persisted.phase !== "scale-running"
          || !persisted.scaleAdmission
          || persisted.scaleAdmission.admissionId !== scaleAdmission!.admissionId
          || persisted.scaleAdmission.boundRunId !== undefined) {
          throw new Error("Scale admission persistence did not acknowledge the exact unbound admission.");
        }
      }
      const receipt = await this.#deps.client.spawn({
        agent: active.agent,
        task: assignment,
        cwd: this.#deps.cwd(),
        config: config.faculties[normalized.faculty],
        timeoutMs: launchBackstopMs(softTimeoutMs),
      });
      if (this.#active !== active) throw new Error("Godmode active slot changed during faculty launch; refusing ambiguous ownership.");
      active.runId = receipt.runId;
      if (normalized.faculty === "scale") {
        try {
          const bound = this.#deps.bindScaleAdmission!(scaleAdmission!.admissionId, receipt.runId);
          if (bound.phase !== "scale-running"
            || bound.scaleAdmission?.admissionId !== scaleAdmission!.admissionId
            || bound.scaleAdmission.boundRunId !== receipt.runId) {
            throw new Error("Scale admission bind callback did not acknowledge the exact run binding.");
          }
        } catch (error) {
          try { await this.#deps.client.stop(receipt.runId, "Scale admission binding failed; the unbound run cannot be reviewed."); } catch { /* fail closed below */ }
          this.#finish(active, "failed", {
            kind: "scale-admission-bind-failure",
            reason: error instanceof Error ? error.message : String(error),
          });
          this.#emit();
          throw error;
        }
      }
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
          // The child may own the slot even though correlation was lost. Keep
          // hand-running and its monitor so a late terminal event cannot be
          // mistaken for an unguarded completion.
          this.#degrade(`Faculty launch outcome is uncertain; the active slot remains reserved: ${error.message}`);
        } else {
          if (active.faculty === "hand") {
            this.#persistWorkflowPhaseBestEffort(active, "blocked", "Hand launch failed before child ownership was established.", "workflow:blocked:hand-launch");
          } else if (active.faculty === "scale") {
            this.#persistWorkflowPhaseBestEffort(active, "blocked", "Scale launch failed before child ownership was established.", "workflow:blocked:scale-launch");
          }
          this.#disposeHandMonitor();
          this.#active = undefined;
          this.#activeHandRedIdentity = undefined;
          this.#activeHandRedCompromised = false;
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
    this.#disposeHandMonitor();
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
      this.#disposeHandMonitor();
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
    let finalState = state;
    let finalResult = result;
    let redTestIntact = true;
    if (active.faculty === "hand" && this.#activeHandRedIdentity) {
      let monitorCompromised = false;
      try { monitorCompromised = this.#activeHandRedMonitor?.isCompromised?.() ?? false; } catch { monitorCompromised = true; }
      const stickyCompromise = this.#activeHandRedCompromised || monitorCompromised;
      try {
        redTestIntact = !stickyCompromise && verifyRedTestIdentity(this.#deps.cwd(), this.#activeHandRedIdentity);
      } catch {
        redTestIntact = false;
      }
    }
    if (!redTestIntact) {
      // The red test is an immutable admission identity. A changed, renamed,
      // removed, weakened, or restored test cannot turn a terminal child
      // result into a successful handoff.
      finalState = "failed";
      finalResult = {
        kind: "red-test-integrity-failure",
        reason: "The admitted red-test content was changed during Hand or no longer matches its SHA-256 identity/meaningful-assertion policy.",
        childResult: result,
      };
    }
    if (active.faculty === "hand") {
      const target: WorkflowPhase = finalState === "complete" && redTestIntact ? "hand-handoff" : "blocked";
      try {
        this.#persistWorkflowPhase(active, target,
          target === "hand-handoff" ? "Hand completed with the immutable red test intact; handoff awaits Primary verification." : "Hand terminal result or immutable red-test integrity was not acceptable.",
          target === "hand-handoff" ? "workflow:hand-handoff" : "workflow:blocked:hand-terminal");
      } catch (error) {
        // A child result never constitutes acceptance. If the canonical
        // transition cannot be acknowledged, report failure and degrade while
        // releasing the terminal child slot.
        finalState = "failed";
        finalResult = {
          kind: "workflow-transition-persistence-failure",
          reason: error instanceof Error ? error.message : String(error),
          childResult: finalResult,
        };
        this.#degrade(`Hand terminal workflow transition could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
        this.#persistWorkflowPhaseBestEffort(active, "blocked", "Hand terminal workflow transition failed closed.", "workflow:blocked:persistence-failure");
      }
    } else if (active.faculty === "scale" && finalState !== "complete") {
      // Scale failures are never review evidence. Fail closed before exposing
      // the terminal result as available to the Primary controller.
      try {
        this.#persistWorkflowPhase(active, "blocked", "Scale did not complete successfully; the mandatory Scale gate is blocked.", "workflow:blocked:scale-terminal");
      } catch (error) {
        finalState = "failed";
        finalResult = {
          kind: "workflow-transition-persistence-failure",
          reason: error instanceof Error ? error.message : String(error),
          childResult: finalResult,
        };
        this.#degrade(`Scale terminal workflow transition could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
        this.#persistWorkflowPhaseBestEffort(active, "blocked", "Scale terminal workflow transition failed closed.", "workflow:blocked:persistence-failure");
      }
    }
    this.#lastRun = {
      runId: active.runId,
      ...(active.admissionId !== undefined ? { admissionId: active.admissionId } : {}),
      faculty: active.faculty,
      state: finalState,
      ...(active.deadline ? { deadline: this.#snapshotDeadline(active.deadline) } : {}),
      result: finalResult,
    };
    this.#disposeHandMonitor();
    this.#active = undefined;
    this.#activeHandRedIdentity = undefined;
    this.#activeHandRedCompromised = false;
  }

  #readWorkflowRecord(): WorkflowRecord | undefined {
    try {
      return (this.#deps.getWorkflowRecord ?? this.#deps.workflowRecord)?.();
    } catch {
      return undefined;
    }
  }

  #persistWorkflowPhase(active: ActiveRun, to: WorkflowPhase, reason: string, reference: string): void {
    if (active.faculty !== "hand" && active.faculty !== "scale") return;
    if (!this.#deps.persistWorkflowTransition) throw new Error("Trusted workflow lifecycle persistence is unavailable.");
    this.#deps.persistWorkflowTransition(to, reason, reference);
  }

  #persistWorkflowPhaseBestEffort(active: ActiveRun, to: WorkflowPhase, reason: string, reference: string): void {
    if (active.faculty !== "hand" && active.faculty !== "scale") return;
    if (!this.#deps.persistWorkflowTransition) return;
    try { this.#deps.persistWorkflowTransition(to, reason, reference); } catch (error) {
      this.#degrade(`Workflow failure transition could not be persisted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #disposeHandMonitor(): void {
    try { this.#activeHandRedMonitor?.dispose(); } catch { /* terminal cleanup is best effort */ }
    this.#activeHandRedMonitor = undefined;
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
