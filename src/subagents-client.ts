import { randomUUID } from "node:crypto";
import type { AsyncRunStatus, FacultyConfig, SpawnReceipt, TerminalRunState } from "./types.ts";

export const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const CONTROL_EVENT = "subagent:control-event";

export interface EventBus {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
}

export interface RpcReply<T = unknown> {
  version: 1;
  requestId: string;
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

export interface PingData {
  version: number;
  methods: string[];
  capabilities: Record<string, unknown>;
  events: Record<string, unknown>;
  session?: Record<string, unknown>;
}

export class AmbiguousRpcOutcomeError extends Error {
  constructor(message: string) { super(message); this.name = "AmbiguousRpcOutcomeError"; }
}

export interface SubagentsClientOptions {
  timeoutMs?: number;
  idFactory?: () => string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function terminal(value: unknown): TerminalRunState | undefined {
  if (value === "complete" || value === "completed") return "complete";
  if (value === "failed" || value === "stopped" || value === "rejected") return value;
  return undefined;
}

export function completionState(value: unknown): TerminalRunState | "needs_attention" {
  const data = record(value) ?? {};
  if (data.state === "paused" || data.status === "paused") return "needs_attention";
  const direct = terminal(data.state) ?? terminal(data.status);
  if (direct) return direct;
  if (data.stopped === true) return "stopped";
  const results = Array.isArray(data.results) ? data.results.map(record).filter(Boolean) as Record<string, unknown>[] : [];
  for (const result of results) {
    const state = terminal(result.status) ?? terminal(result.state);
    if (state && state !== "complete") return state;
    if (result.success === false) return "failed";
  }
  if (data.success === false || typeof data.error === "string") return "failed";
  return "complete";
}

export class SubagentsClient {
  readonly #events: EventBus;
  readonly #timeoutMs: number;
  readonly #idFactory: () => string;

  constructor(events: EventBus, options: SubagentsClientOptions = {}) {
    this.#events = events;
    this.#timeoutMs = options.timeoutMs ?? 8_000;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const requestId = this.#idFactory();
    const event = `${RPC_REPLY_PREFIX}${requestId}`;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        callback();
      };
      const timer = setTimeout(() => finish(() => reject(new AmbiguousRpcOutcomeError(`pi-subagents RPC '${method}' timed out after ${this.#timeoutMs}ms; execution outcome is uncertain.`))), this.#timeoutMs);
      const maybeUnsubscribe = this.#events.on(event, (raw) => {
        const reply = record(raw) as unknown as RpcReply<T> | undefined;
        if (!reply || reply.version !== 1 || reply.requestId !== requestId) return;
        finish(() => {
          if (!reply.success) reject(new Error(`pi-subagents RPC '${method}' failed${reply.error?.code ? ` (${reply.error.code})` : ""}: ${reply.error?.message ?? "unknown error"}`));
          else resolve(reply.data as T);
        });
      });
      if (typeof maybeUnsubscribe === "function") unsubscribe = maybeUnsubscribe;
      this.#events.emit(RPC_REQUEST_EVENT, {
        version: 1,
        requestId,
        method,
        ...(params ? { params } : {}),
        source: { extension: "pi-godmode" },
      });
    });
  }

  async ping(): Promise<PingData> {
    const data = await this.request<PingData>("ping");
    if (data.version !== 1 || !Array.isArray(data.methods)) throw new Error("pi-subagents returned an incompatible RPC protocol.");
    const methods = new Set(data.methods);
    for (const method of ["ping", "spawn", "status", "steer", "stop"]) {
      if (!methods.has(method)) throw new Error(`Compatible pi-subagents is required: missing RPC method '${method}'.`);
    }
    const capabilities = record(data.capabilities) ?? {};
    const events = record(data.events) ?? {};
    if (capabilities.asyncSpawn !== true) throw new Error("Compatible pi-subagents is required: asyncSpawn capability is missing.");
    if (capabilities.nonRecoveringSteer !== true) throw new Error("Compatible pi-subagents is required: acknowledged non-recovering steer is missing.");
    if (capabilities.stop !== true || capabilities.status !== true) throw new Error("Compatible pi-subagents is required: status/stop capabilities are missing.");
    if (!record(capabilities.fleetStatus) || record(capabilities.fleetStatus)?.version !== 1) throw new Error("Compatible pi-subagents is required: fleetStatus v1 is missing.");
    if (!record(capabilities.processTerminalProof)) throw new Error("Compatible pi-subagents is required: process-terminal proof is missing.");
    if (events.asyncComplete !== ASYNC_COMPLETE_EVENT) throw new Error("Compatible pi-subagents is required: exact async completion correlation is missing.");
    return data;
  }

  async spawn(input: { agent: string; task: string; cwd: string; config: FacultyConfig }): Promise<SpawnReceipt> {
    const data = await this.request<Record<string, unknown>>("spawn", {
      agent: input.agent,
      task: input.task,
      cwd: input.cwd,
      context: "fresh",
      async: true,
      timeoutMs: input.config.timeoutMs,
      model: `${input.config.provider}/${input.config.model}:${input.config.thinking}`,
      artifacts: true,
    });
    const details = record(data.details);
    const runId = typeof details?.runId === "string" ? details.runId : typeof details?.asyncId === "string" ? details.asyncId : typeof data.runId === "string" ? data.runId : undefined;
    if (!runId) throw new AmbiguousRpcOutcomeError("pi-subagents spawn reply did not contain a runId; execution correlation is uncertain.");
    return { runId, state: "running", raw: data };
  }

  async status(runId: string): Promise<AsyncRunStatus> {
    const data = await this.request<Record<string, unknown>>("status", { id: runId });
    const snapshot = record(data.asyncSnapshot);
    const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
    const node = runs.map(record).find((entry) => entry?.id === runId);
    if (!node) throw new Error(`pi-subagents status is ambiguous: exact run '${runId}' is absent from the bounded async snapshot.`);
    const state = node.state;
    const activity = record(node.activity);
    if (state === "paused" || (activity?.state === "needs_attention" && (state === "queued" || state === "running"))) return { runId, state: "needs_attention", raw: data };
    if (state === "queued" || state === "running" || state === "stopping" || terminal(state)) return { runId, state: (terminal(state) ?? state) as AsyncRunStatus["state"], raw: data };
    throw new Error(`pi-subagents returned unknown state '${String(state)}' for run '${runId}'.`);
  }

  async steer(runId: string, message: string): Promise<unknown> {
    return this.request("steer", { id: runId, message, mode: "steer" });
  }

  async stop(runId: string, reason?: string): Promise<unknown> {
    return this.request("stop", { id: runId, ...(reason?.trim() ? { reason: reason.trim() } : {}) });
  }

  onCompletion(handler: (payload: unknown) => void): () => void {
    const unsubscribe = this.#events.on(ASYNC_COMPLETE_EVENT, handler);
    return typeof unsubscribe === "function" ? unsubscribe : () => {};
  }

  onControl(handler: (payload: unknown) => void): () => void {
    const unsubscribe = this.#events.on(CONTROL_EVENT, handler);
    return typeof unsubscribe === "function" ? unsubscribe : () => {};
  }
}
