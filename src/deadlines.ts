/** Maximum timeout accepted by the pi-subagents launch contract and Node timers. */
export const MAX_DEADLINE_MS = 2_147_483_647;
/** The default soft-deadline grace period is bounded and never exceeds five minutes. */
export const MAX_DEADLINE_GRACE_MS = 5 * 60 * 1_000;
/** A supervisor may grant at most one explicit extension of this size per run. */
export const MAX_SUPERVISOR_EXTENSION_MS = 5 * 60 * 1_000;

/**
 * Existing faculty timeoutMs values are soft deadlines. Keep a finite,
 * conservative backstop without requiring a config migration: short runs get
 * one additional run-length of grace, while longer runs get five minutes.
 */
export function deadlineGraceMs(softDeadlineMs: number): number {
  return Math.min(softDeadlineMs, MAX_DEADLINE_GRACE_MS);
}

export function hardDeadlineMs(softDeadlineMs: number): number {
  return Math.min(MAX_DEADLINE_MS, softDeadlineMs + deadlineGraceMs(softDeadlineMs));
}

/**
 * pi-subagents has no live deadline-update RPC. Reserve the maximum single
 * supervisor extension in its own finite timeout, while Godmode's timer still
 * enforces the current (possibly extended) hard deadline earlier.
 */
export function launchBackstopMs(softDeadlineMs: number): number {
  return Math.min(MAX_DEADLINE_MS, hardDeadlineMs(softDeadlineMs) + MAX_SUPERVISOR_EXTENSION_MS);
}

/** Extension headroom actually reserved inside the immutable launch timeout. */
export function extensionCapacityMs(softDeadlineMs: number): number {
  return launchBackstopMs(softDeadlineMs) - hardDeadlineMs(softDeadlineMs);
}
