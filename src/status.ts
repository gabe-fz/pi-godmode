import type { GodmodeSnapshot } from "./types.ts";

function label(faculty: "eye" | "hand" | "scale"): string {
  return faculty[0]!.toUpperCase() + faculty.slice(1);
}

export function statusLine(snapshot: GodmodeSnapshot): string | undefined {
  if (snapshot.phase === "off" || snapshot.phase === "enabling" || snapshot.phase === "stopping") return snapshot.phase === "off" ? undefined : `GODMODE ● ${snapshot.phase}`;
  if (snapshot.phase === "degraded") return "GODMODE ● degraded";
  if (snapshot.activeRun?.deadline?.phase === "hard") return `GODMODE ● ${label(snapshot.activeRun.faculty)} hard deadline`;
  if (snapshot.activeRun?.deadline?.phase === "pending") return `GODMODE ● ${label(snapshot.activeRun.faculty)} deadline pending`;
  if (snapshot.activeRun?.deadline?.phase === "extended") return `GODMODE ● ${label(snapshot.activeRun.faculty)} deadline extended`;
  if (snapshot.activeRun?.phase === "attention") return "GODMODE ● decision requested";
  if (snapshot.activeRun) return `GODMODE ● ${label(snapshot.activeRun.faculty)} running`;
  if (snapshot.lastRun) return "GODMODE ● result ready";
  return "GODMODE ● idle";
}

export function boundedStatus(snapshot: GodmodeSnapshot): Record<string, unknown> {
  return {
    mode: snapshot.phase,
    delegation: snapshot.delegation,
    ...(snapshot.activeRun ? {
      active: {
        runId: snapshot.activeRun.runId,
        faculty: snapshot.activeRun.faculty,
        agent: snapshot.activeRun.agent,
        state: snapshot.activeRun.phase,
        title: snapshot.activeRun.title.slice(0, 160),
        ...(snapshot.activeRun.deadline ? {
          deadline: {
            phase: snapshot.activeRun.deadline.phase,
            softDeadlineAt: snapshot.activeRun.deadline.softDeadlineAt,
            hardDeadlineAt: snapshot.activeRun.deadline.hardDeadlineAt,
            remainingMs: snapshot.activeRun.deadline.remainingMs,
            hardRemainingMs: snapshot.activeRun.deadline.hardRemainingMs,
            checkpoint: snapshot.activeRun.deadline.checkpoint,
            ...(snapshot.activeRun.deadline.checkpointRequestedAt !== undefined ? { checkpointRequestedAt: snapshot.activeRun.deadline.checkpointRequestedAt } : {}),
            ...(snapshot.activeRun.deadline.extensionMs !== undefined ? { extensionMs: snapshot.activeRun.deadline.extensionMs } : {}),
          },
        } : {}),
      },
    } : {}),
    ...(snapshot.lastRun ? {
      lastRun: {
        runId: snapshot.lastRun.runId,
        faculty: snapshot.lastRun.faculty,
        state: snapshot.lastRun.state,
        ...(snapshot.lastRun.deadline ? {
          deadline: {
            phase: snapshot.lastRun.deadline.phase,
            softDeadlineAt: snapshot.lastRun.deadline.softDeadlineAt,
            hardDeadlineAt: snapshot.lastRun.deadline.hardDeadlineAt,
            remainingMs: snapshot.lastRun.deadline.remainingMs,
            hardRemainingMs: snapshot.lastRun.deadline.hardRemainingMs,
            checkpoint: snapshot.lastRun.deadline.checkpoint,
            ...(snapshot.lastRun.deadline.checkpointRequestedAt !== undefined ? { checkpointRequestedAt: snapshot.lastRun.deadline.checkpointRequestedAt } : {}),
            ...(snapshot.lastRun.deadline.extensionMs !== undefined ? { extensionMs: snapshot.lastRun.deadline.extensionMs } : {}),
          },
        } : {}),
      },
    } : {}),
    ...(snapshot.degradedReason ? { degradedReason: snapshot.degradedReason.slice(0, 1_024) } : {}),
  };
}
