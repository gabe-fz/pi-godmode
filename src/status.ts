import type { GodmodeSnapshot } from "./types.ts";

function label(faculty: "eye" | "hand" | "scale"): string {
  return faculty[0]!.toUpperCase() + faculty.slice(1);
}

export function statusLine(snapshot: GodmodeSnapshot): string | undefined {
  if (snapshot.phase === "off" || snapshot.phase === "enabling" || snapshot.phase === "stopping") return snapshot.phase === "off" ? undefined : `GODMODE ● ${snapshot.phase}`;
  if (snapshot.phase === "degraded") return "GODMODE ● degraded";
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
      },
    } : {}),
    ...(snapshot.lastRun ? { lastRun: { runId: snapshot.lastRun.runId, faculty: snapshot.lastRun.faculty, state: snapshot.lastRun.state } } : {}),
    ...(snapshot.degradedReason ? { degradedReason: snapshot.degradedReason.slice(0, 1_024) } : {}),
  };
}
