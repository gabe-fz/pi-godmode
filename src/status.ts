import type { GodmodeSnapshot } from "./types.ts";
import type { ChecklistView } from "./workflow-state.ts";

const STATUS_MAX_BYTES = 256;

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(`${output}${character}`, "utf8") > maximumBytes) break;
    output += character;
  }
  return output;
}

function workflowSummary(workflow: Readonly<ChecklistView>): string {
  const items = workflow.items;
  const settled = items.filter((item) => item.status === "verified" || item.status === "waived").length;
  const blocked = items.filter((item) => item.status === "blocked").length;
  return ` · FLOW ${workflow.phase} ${settled}/${items.length} · blocked ${blocked} · next ${workflow.nextGate}`;
}

function label(faculty: "eye" | "hand" | "scale"): string {
  return faculty[0]!.toUpperCase() + faculty.slice(1);
}

export function statusLine(snapshot: GodmodeSnapshot, workflow?: Readonly<ChecklistView>): string | undefined {
  let operational: string | undefined;
  if (snapshot.phase === "off" || snapshot.phase === "enabling" || snapshot.phase === "stopping") {
    operational = snapshot.phase === "off" ? undefined : `GODMODE ● ${snapshot.phase}`;
  } else if (snapshot.phase === "degraded") {
    operational = "GODMODE ● degraded";
  } else if (snapshot.activeRun?.deadline?.phase === "hard") {
    operational = `GODMODE ● ${label(snapshot.activeRun.faculty)} hard deadline`;
  } else if (snapshot.activeRun?.deadline?.phase === "pending") {
    operational = `GODMODE ● ${label(snapshot.activeRun.faculty)} deadline pending`;
  } else if (snapshot.activeRun?.deadline?.phase === "extended") {
    operational = `GODMODE ● ${label(snapshot.activeRun.faculty)} deadline extended`;
  } else if (snapshot.activeRun?.phase === "attention") {
    operational = "GODMODE ● decision requested";
  } else if (snapshot.activeRun) {
    operational = `GODMODE ● ${label(snapshot.activeRun.faculty)} running`;
  } else if (snapshot.lastRun) {
    operational = "GODMODE ● result ready";
  } else {
    operational = "GODMODE ● idle";
  }
  if (operational === undefined || workflow === undefined) return operational;
  return truncateUtf8(`${operational}${workflowSummary(workflow)}`, STATUS_MAX_BYTES);
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
