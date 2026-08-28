export const FACULTIES = ["eye", "hand", "scale"] as const;
export type Faculty = (typeof FACULTIES)[number];
export type AgentName = `godmode-${Faculty}`;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type GodmodeThinking = "medium" | "high" | "xhigh";

export interface ModelTuple {
  provider: string;
  model: string;
}

export interface FacultyConfig extends ModelTuple {
  thinking: ThinkingLevel;
  timeoutMs: number;
}

export interface GodmodeConfig {
  schemaVersion: 1;
  godmodePolicy: {
    allowedModels: ModelTuple[];
    minimumThinking: GodmodeThinking;
  };
  faculties: Record<Faculty, FacultyConfig>;
}

export interface DelegationInput {
  faculty: Faculty;
  title: string;
  task: string;
  contextFiles?: string[];
  expectedPaths?: string[];
  acceptanceChecks?: string[];
  constraints?: string[];
}

export interface NormalizedDelegation extends DelegationInput {
  contextFiles: string[];
  expectedPaths: string[];
  acceptanceChecks: string[];
  constraints: string[];
}

export type ModePhase = "off" | "enabling" | "active" | "degraded" | "stopping";
export type DelegationPhase = "idle" | "launching" | "running" | "attention" | "stopping" | "terminal";
export type TerminalRunState = "complete" | "failed" | "stopped" | "rejected";

export interface ActiveRun {
  runId?: string;
  faculty: Faculty;
  agent: AgentName;
  title: string;
  assignment: string;
  phase: Exclude<DelegationPhase, "idle" | "terminal">;
  startedAt: number;
  result?: unknown;
}

export interface GodmodeSnapshot {
  phase: ModePhase;
  delegation: DelegationPhase;
  activeRun?: Readonly<ActiveRun>;
  lastRun?: {
    runId: string;
    faculty: Faculty;
    state: TerminalRunState;
    result?: unknown;
  };
  degradedReason?: string;
}

export interface Disposable {
  dispose(): void;
}

export interface AsyncRunStatus {
  runId: string;
  state: "queued" | "running" | "needs_attention" | "stopping" | TerminalRunState;
  raw?: unknown;
}

export interface SpawnReceipt {
  runId: string;
  state: "queued" | "running";
  raw?: unknown;
}
