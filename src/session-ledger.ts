import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  type CompletionCapsule,
  type LedgerSnapshot,
  type LedgerSnapshotInput,
  type WorkflowRecord,
  type WorkflowProjection,
} from "./types.ts";
import { validateWorkflowRecord } from "./workflow-state.ts";

export const LEDGER_SCHEMA_VERSION = 1 as const;
export const LEDGER_CUSTOM_TYPE = "godmode-workflow-ledger";
const MAX_PROJECTION_BYTES = 2_048;
const MAX_STRING_LENGTH = 1_024;
const MAX_COLLECTION_LENGTH = 64;
const MAX_DEPTH = 8;
const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";

interface SanitizeOptions {
  maxStringLength?: number;
  maxCollectionLength?: number;
  maxDepth?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

const SENSITIVE_KEY = /(?:authorization|api[_-]?key|access[_-]?key|access[_-]?token|id[_-]?token|refresh[_-]?token|token|secret|password|passwd|passphrase|credential|private[_-]?key|cookie|set-cookie|signature)/i;
const URL_SECRET_PARAMETER = /([?&](?:x-amz-signature|x-amz-security-token|signature|sig|access[_-]?token|api[_-]?key|token|secret|password|credential)=)([^&#\s]*)/gi;
const SECRET_VALUE = /(?:bearer\s+[^\s,;]+|basic\s+[^\s,;]+|(?:api[_-]?key|access[_-]?key|access[_-]?token|id[_-]?token|refresh[_-]?token|token|secret|password|passwd|passphrase|credential|signature)\s*[:=]\s*[^\s,;&]+|(?:sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}|-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----)/gi;

function hasSecretLike(value: string): boolean {
  SECRET_VALUE.lastIndex = 0;
  const secret = SECRET_VALUE.test(value);
  SECRET_VALUE.lastIndex = 0;
  URL_SECRET_PARAMETER.lastIndex = 0;
  const urlSecret = URL_SECRET_PARAMETER.test(value);
  URL_SECRET_PARAMETER.lastIndex = 0;
  return secret || urlSecret;
}

function sanitizeString(value: string, maxLength: number): string {
  // Redact URL query credentials while retaining enough URL provenance to be
  // useful to a reviewer. Do this before general secret matching.
  let sanitized = value.replace(URL_SECRET_PARAMETER, `$1${REDACTED}`);
  sanitized = sanitized.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+):([^/@\s]+)@/gi, `$1${REDACTED}@`);
  sanitized = sanitized.replace(SECRET_VALUE, REDACTED);
  if (byteLength(sanitized) > maxLength) sanitized = truncateUtf8(sanitized, maxLength);
  return sanitized;
}

/**
 * Recursively sanitize values before they enter the session ledger. This is
 * intentionally usable on unknown faculty data: cycles, unusual values,
 * excessive nesting, large collections, and long strings are all bounded.
 */
export function sanitizeLedgerValue(value: unknown, options: SanitizeOptions = {}): unknown {
  const maxStringLength = Number.isSafeInteger(options.maxStringLength) ? Math.max(0, options.maxStringLength!) : MAX_STRING_LENGTH;
  const maxCollectionLength = Number.isSafeInteger(options.maxCollectionLength) ? Math.max(0, options.maxCollectionLength!) : MAX_COLLECTION_LENGTH;
  const maxDepth = Number.isSafeInteger(options.maxDepth) ? Math.max(0, options.maxDepth!) : MAX_DEPTH;
  const seen = new WeakSet<object>();

  const visit = (current: unknown, depth: number, key?: string): unknown => {
    if (key !== undefined && SENSITIVE_KEY.test(key)) return REDACTED;
    if (typeof current === "string") return sanitizeString(current, maxStringLength);
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number") return Number.isFinite(current) ? current : null;
    if (typeof current === "bigint") return TRUNCATED;
    if (typeof current === "undefined") return null;
    if (typeof current === "function" || typeof current === "symbol") return TRUNCATED;
    if (depth >= maxDepth) return TRUNCATED;
    if (typeof current !== "object") return TRUNCATED;
    if (seen.has(current)) return TRUNCATED;
    seen.add(current);
    if (Array.isArray(current)) {
      let entries: unknown[];
      try {
        entries = current.slice(0, maxCollectionLength);
      } catch {
        return TRUNCATED;
      }
      return entries.map((entry) => visit(entry, depth + 1));
    }
    let keys: string[];
    try {
      keys = Object.keys(current).slice(0, maxCollectionLength);
    } catch {
      return TRUNCATED;
    }
    const output: Record<string, unknown> = {};
    for (const objectKey of keys) {
      let nested: unknown;
      try {
        nested = (current as Record<string, unknown>)[objectKey];
      } catch {
        nested = TRUNCATED;
      }
      Object.defineProperty(output, objectKey, {
        value: visit(nested, depth + 1, objectKey),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  };
  return visit(value, 0);
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item, seen);
  } else {
    for (const item of Object.values(value)) freezeDeep(item, seen);
  }
  return Object.freeze(value);
}

function validTimestamp(value: unknown): value is string {
  // Host timestamps are opaque strings at this layer. Requiring non-empty
  // metadata avoids accepting malformed roots without imposing a clock/format
  // policy on callers.
  return nonEmptyString(value);
}

function validIdentity(value: unknown): value is string {
  return nonEmptyString(value) && byteLength(value) <= MAX_STRING_LENGTH;
}

function sanitizedRecord(record: WorkflowRecord): WorkflowRecord {
  const value = sanitizeLedgerValue(record, {
    maxStringLength: MAX_STRING_LENGTH,
    maxCollectionLength: MAX_COLLECTION_LENGTH,
    maxDepth: MAX_DEPTH,
  });
  const validation = validateWorkflowRecord(value);
  if (!validation.ok) throw new Error(`Workflow record cannot be safely persisted: ${validation.reason}`);
  return validation.record;
}

/** Create a schema-v1 custom-entry payload without retaining raw details. */
export function createLedgerSnapshot(input: LedgerSnapshotInput): LedgerSnapshot {
  if (!validIdentity(input.sessionId) || !validIdentity(input.workItemId)) {
    throw new Error("Ledger snapshot requires bounded session and work-item identities.");
  }
  const safeSessionId = sanitizeLedgerValue(input.sessionId);
  const safeWorkItemId = sanitizeLedgerValue(input.workItemId);
  if (safeSessionId !== input.sessionId || safeWorkItemId !== input.workItemId) {
    throw new Error("Ledger snapshot identity resembles sensitive data and cannot be persisted.");
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error("Ledger snapshot generation must be a positive safe integer.");
  }
  if (input.predecessorEntryId !== undefined && input.predecessorEntryId !== null && !validIdentity(input.predecessorEntryId)) {
    throw new Error("Ledger snapshot predecessor entry ID is invalid.");
  }
  if (!validTimestamp(input.createdAt)) throw new Error("Ledger snapshot timestamp is invalid.");
  const recordValidation = validateWorkflowRecord(input.record);
  if (!recordValidation.ok) throw new Error(recordValidation.reason);
  if (recordValidation.record.workItemId !== input.workItemId) {
    throw new Error("Ledger snapshot session work-item identity conflicts with the record.");
  }
  const persistedRecord = sanitizedRecord(recordValidation.record);
  if (persistedRecord.workItemId !== input.workItemId) {
    throw new Error("Ledger snapshot record identity resembles sensitive data and cannot be persisted.");
  }
  const persistedTimestamp = sanitizeLedgerValue(input.createdAt);
  const persistedPredecessor = input.predecessorEntryId === undefined || input.predecessorEntryId === null
    ? null
    : sanitizeLedgerValue(input.predecessorEntryId);
  if (persistedTimestamp !== input.createdAt || persistedPredecessor !== (input.predecessorEntryId ?? null)) {
    throw new Error("Ledger snapshot metadata resembles sensitive data and cannot be persisted.");
  }
  const snapshot: LedgerSnapshot = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    sessionId: input.sessionId,
    workItemId: input.workItemId,
    generation: input.generation,
    predecessorEntryId: input.predecessorEntryId ?? null,
    createdAt: input.createdAt,
    record: persistedRecord,
  };
  // The returned object mirrors the immutable custom-entry payload. A caller
  // can still spread it to make a successor, but cannot alter this snapshot.
  return freezeDeep(snapshot);
}

type LedgerCustomEntry = Extract<SessionEntry, { type: "custom" }>;
type StoredLedgerEntry = LedgerCustomEntry & { data: unknown; customType: typeof LEDGER_CUSTOM_TYPE };

function isLedgerEntry(entry: SessionEntry): entry is StoredLedgerEntry {
  return entry.type === "custom" && entry.customType === LEDGER_CUSTOM_TYPE;
}

function isSnapshot(value: unknown): value is LedgerSnapshot {
  if (!isObject(value)
    || value.schemaVersion !== LEDGER_SCHEMA_VERSION
    || !validIdentity(value.sessionId)
    || !validIdentity(value.workItemId)
    || typeof value.generation !== "number"
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1
    || (value.predecessorEntryId !== null && !validIdentity(value.predecessorEntryId))
    || !validTimestamp(value.createdAt)) return false;
  const validation = validateWorkflowRecord(value.record);
  return validation.ok && validation.record.workItemId === value.workItemId;
}

export interface ActiveSnapshot {
  status: "ok";
  entryId: string;
  snapshot: LedgerSnapshot;
}
export interface AbsentSnapshot {
  status: "absent";
}
export interface BlockedSnapshot {
  status: "blocked";
  reason: string;
}
export type SnapshotRecovery = ActiveSnapshot | AbsentSnapshot | BlockedSnapshot;

function blocked(reason: string): BlockedSnapshot {
  return { status: "blocked", reason };
}

function validParentChain(entriesById: Map<string, SessionEntry>, entry: SessionEntry): boolean {
  const seen = new Set<string>();
  let parentId: string | null = entry.parentId;
  while (parentId !== null) {
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    const parent = entriesById.get(parentId);
    if (!parent) return false;
    parentId = parent.parentId;
  }
  return true;
}

function hasAncestor(entriesById: Map<string, SessionEntry>, entry: SessionEntry, ancestorId: string): boolean {
  const seen = new Set<string>();
  let parentId: string | null = entry.parentId;
  while (parentId !== null) {
    if (parentId === ancestorId) return true;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    const parent = entriesById.get(parentId);
    if (!parent) return false;
    parentId = parent.parentId;
  }
  return false;
}

/**
 * Reconstruct the one active work-item chain from an already branch-filtered
 * SessionManager entry list. Pi entry ancestry, not timestamps, establishes
 * the branch and predecessor relationship.
 */
export function reconstructActiveSnapshot(
  entries: readonly SessionEntry[],
  sessionId: string,
  workItemId: string,
): SnapshotRecovery {
  if (!validIdentity(sessionId) || !validIdentity(workItemId)) return blocked("Invalid session or work-item identity; recovery blocked.");
  if (!Array.isArray(entries)) return blocked("Malformed active branch lineage; recovery blocked.");
  const entriesById = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (!isObject(entry) || !nonEmptyString(entry.id) || (entry.parentId !== null && typeof entry.parentId !== "string") || entriesById.has(entry.id)) {
      return blocked("Duplicate or malformed session entry lineage; recovery blocked.");
    }
    entriesById.set(entry.id, entry as unknown as SessionEntry);
  }
  const candidates: Array<{ entry: StoredLedgerEntry; snapshot: LedgerSnapshot }> = [];
  for (const entry of entries) {
    if (!isLedgerEntry(entry)) continue;
    const raw = entry.data;
    // Other work items may coexist in a session branch. A payload that cannot
    // identify its item is malformed; a well-formed different item is ignored.
    if (isObject(raw) && typeof raw.workItemId === "string" && raw.workItemId !== workItemId) continue;
    const safeRaw = sanitizeLedgerValue(raw);
    if (!isSnapshot(safeRaw)) return blocked("Invalid workflow ledger snapshot data; recovery blocked.");
    if (safeRaw.sessionId !== sessionId) return blocked("Cross-session workflow ledger snapshot; recovery blocked.");
    if (safeRaw.workItemId !== workItemId) return blocked("Workflow snapshot identity was altered by sanitization; recovery blocked.");
    candidates.push({ entry, snapshot: freezeDeep(safeRaw) });
  }
  if (candidates.length === 0) return { status: "absent" };

  const byGeneration = new Map<number, { entry: StoredLedgerEntry; snapshot: LedgerSnapshot }>();
  const candidateById = new Map<string, { entry: StoredLedgerEntry; snapshot: LedgerSnapshot }>();
  for (const candidate of candidates) {
    const prior = byGeneration.get(candidate.snapshot.generation);
    if (prior) return blocked("Conflicting duplicate workflow snapshot generation; recovery blocked.");
    byGeneration.set(candidate.snapshot.generation, candidate);
    candidateById.set(candidate.entry.id, candidate);
  }
  for (const candidate of candidates) {
    if (!validParentChain(entriesById, candidate.entry)) {
      return blocked("Missing or cyclic workflow snapshot branch root/parent lineage; recovery blocked.");
    }
    const predecessorId = candidate.snapshot.predecessorEntryId;
    if (candidate.snapshot.generation === 1) {
      if (predecessorId !== null) return blocked("Generation-one workflow snapshot has a predecessor; recovery blocked.");
    } else {
      if (predecessorId === null) return blocked("Workflow snapshot is missing its predecessor; recovery blocked.");
      const predecessor = candidateById.get(predecessorId);
      if (!predecessor) return blocked("Workflow snapshot predecessor is missing or cross-session; recovery blocked.");
      if (predecessor.snapshot.generation + 1 !== candidate.snapshot.generation) {
        return blocked("Workflow snapshot generation is not monotonic; recovery blocked.");
      }
      if (!hasAncestor(entriesById, candidate.entry, predecessorId)) {
        return blocked("Workflow snapshot predecessor is off-branch; recovery blocked.");
      }
    }
  }
  const highest = [...candidates].sort((left, right) => right.snapshot.generation - left.snapshot.generation)[0];
  if (!highest) return { status: "absent" };
  return { status: "ok", entryId: highest.entry.id, snapshot: highest.snapshot };
}

function changedBySanitization(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return byteLength(value) > MAX_STRING_LENGTH || hasSecretLike(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return true;
    seen.add(value);
    const changed = value.length > MAX_COLLECTION_LENGTH || value.some((entry) => changedBySanitization(entry, seen));
    return changed;
  }
  if (isObject(value)) {
    if (seen.has(value)) return true;
    seen.add(value);
    const changed = Object.entries(value).some(([key, entry]) => SENSITIVE_KEY.test(key) || changedBySanitization(entry, seen));
    return changed;
  }
  return false;
}

function fits(value: unknown): boolean {
  const text = safeJson(value);
  return text.length > 0 && byteLength(text) <= MAX_PROJECTION_BYTES;
}

function addIfFits(target: Record<string, unknown>, key: string, value: unknown): boolean {
  const previous = target[key];
  target[key] = value;
  if (!fits(target)) {
    if (previous === undefined) delete target[key];
    else target[key] = previous;
    return false;
  }
  return true;
}

/**
 * Required projection state must be represented in full or the projection is
 * unusable. Sanitization may redact a value, but it must not silently bound a
 * required collection/string and thereby turn an incomplete projection into
 * apparently current state.
 */
function requiresRequiredBounding(value: unknown, seen = new WeakSet<object>(), depth = 0): boolean {
  if (typeof value === "string") return byteLength(value) > MAX_STRING_LENGTH;
  if (value === null || typeof value !== "object") return false;
  if (depth >= MAX_DEPTH || seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.length > MAX_COLLECTION_LENGTH
      || value.some((entry) => requiresRequiredBounding(entry, seen, depth + 1));
  }
  return Object.values(value).some((entry) => requiresRequiredBounding(entry, seen, depth + 1));
}

/** Build a deterministic context projection from canonical state only. */
export function projectWorkflowRecord(record: WorkflowRecord): WorkflowProjection {
  const validation = validateWorkflowRecord(record);
  if (!validation.ok) return { text: "", truncated: false, blocked: true, reason: validation.reason };
  const current = validation.record;

  // Pending roadmap items are routine context. Preserve every exceptional
  // status (including its item identity) because dropping one can hide a
  // blocker or make an unverified/waived item appear pending.
  const exceptionalRoadmap = current.roadmap
    .filter((item) => item.status !== "pending")
    .map((item) => ({ id: item.id, status: item.status }));
  const rawRequired: Record<string, unknown> = {
    workItemId: current.workItemId,
    classification: current.classification,
    phase: current.phase,
    nextGate: current.nextGate,
    roadmap: exceptionalRoadmap,
    blockers: current.blockers,
    residualRisks: current.residualRisks,
    ...(current.tddWaiverReference !== undefined ? { tddWaiverReference: current.tddWaiverReference } : {}),
    ...(current.scaleWaiverReference !== undefined ? { scaleWaiverReference: current.scaleWaiverReference } : {}),
  };
  // Check the unsanitized required state before redaction. A sanitized marker
  // is safe for secrets, but truncating required state would be omission.
  if (!fits(rawRequired) || requiresRequiredBounding(rawRequired)) {
    return {
      text: "",
      truncated: false,
      blocked: true,
      reason: "Required workflow projection fields exceed the 2 KiB limit; blocked.",
    };
  }

  const output: Record<string, unknown> = {
    workItemId: sanitizeLedgerValue(current.workItemId),
    classification: current.classification,
    phase: current.phase,
    nextGate: sanitizeLedgerValue(current.nextGate),
    roadmap: sanitizeLedgerValue(exceptionalRoadmap),
    blockers: sanitizeLedgerValue(current.blockers),
    residualRisks: sanitizeLedgerValue(current.residualRisks),
    ...(current.tddWaiverReference !== undefined
      ? { tddWaiverReference: sanitizeLedgerValue(current.tddWaiverReference) }
      : {}),
    ...(current.scaleWaiverReference !== undefined
      ? { scaleWaiverReference: sanitizeLedgerValue(current.scaleWaiverReference) }
      : {}),
  };
  // Recheck after redaction and retain all required keys. This protects
  // against sanitizer expansion (for example, a short secret replacement).
  if (!fits(output)) {
    return {
      text: "",
      truncated: false,
      blocked: true,
      reason: "Required workflow projection fields exceed the 2 KiB limit; blocked.",
    };
  }

  let truncated = changedBySanitization(current.goal)
    || changedBySanitization(current.evidence)
    || changedBySanitization(current.unresolvedDecisions)
    || changedBySanitization(current.redTestReference)
    || changedBySanitization(current.scaleVerdict)
    || changedBySanitization(current.workItemId)
    || changedBySanitization(current.nextGate)
    || changedBySanitization(current.roadmap)
    || changedBySanitization(current.blockers)
    || changedBySanitization(current.residualRisks)
    || changedBySanitization(current.tddWaiverReference)
    || changedBySanitization(current.scaleWaiverReference);
  const optional: Array<[string, unknown]> = [
    ["goal", sanitizeLedgerValue(current.goal)],
    ...(current.unresolvedDecisions !== undefined
      ? [["unresolvedDecisions", sanitizeLedgerValue(current.unresolvedDecisions)] as [string, unknown]]
      : []),
    ["evidence", sanitizeLedgerValue(current.evidence)],
    ...(current.redTestReference !== undefined
      ? [["redTestReference", sanitizeLedgerValue(current.redTestReference)] as [string, unknown]]
      : []),
    ...(current.scaleVerdict !== undefined
      ? [["scaleVerdict", sanitizeLedgerValue(current.scaleVerdict)] as [string, unknown]]
      : []),
  ];
  for (const [key, value] of optional) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    if (!addIfFits(output, key, value)) truncated = true;
  }
  const text = safeJson(output);
  if (!text || byteLength(text) > MAX_PROJECTION_BYTES) {
    return { text: "", truncated, blocked: true, reason: "Workflow projection exceeded the 2 KiB limit; blocked." };
  }
  return Object.freeze({ text, truncated, blocked: false });
}

function capsuleFallback(record: unknown, timestamp: string): CompletionCapsule {
  const workItemId = isObject(record) && typeof record.workItemId === "string" ? sanitizeLedgerValue(record.workItemId) as string : "unknown";
  const safeTimestamp = sanitizeLedgerValue(timestamp);
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    workItemId: truncateUtf8(workItemId, 256),
    classification: "feature",
    phase: "blocked",
    accepted: false,
    roadmap: [],
    requirementIds: [],
    nextGate: "primary-reconcile",
    evidence: [],
    blockers: ["Malformed canonical workflow state; acceptance not implied."],
    residualRisks: [],
    createdAt: typeof safeTimestamp === "string" && safeTimestamp.length > 0 ? truncateUtf8(safeTimestamp, 256) : "unknown",
    truncated: true,
  }; 
}

/* Keep a required capsule string bounded in UTF-8, not only in UTF-16 code
 * units. */
function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  if (byteLength(value) <= maximumBytes) return value;
  if (byteLength(TRUNCATED) > maximumBytes) return "";
  let output = "";
  for (const character of value) {
    if (byteLength(`${output}${character}${TRUNCATED}`) > maximumBytes) break;
    output += character;
  }
  return `${output}${TRUNCATED}`;
}

/** Create a bounded terminal handoff object, never an acceptance decision. */
export function createCompletionCapsule(record: WorkflowRecord, createdAt: string): CompletionCapsule {
  const validation = validateWorkflowRecord(record);
  if (!validation.ok) return capsuleFallback(record, createdAt);
  const current = validation.record;
  const capsule: CompletionCapsule = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    workItemId: sanitizeLedgerValue(current.workItemId) as string,
    classification: current.classification,
    phase: current.phase,
    accepted: current.phase === "accepted" && current.roadmap.every((item) => item.status === "verified" || item.status === "waived"),
    roadmap: current.roadmap.slice(0, MAX_COLLECTION_LENGTH).map((item) => ({ id: item.id, status: item.status })),
    requirementIds: [...current.requirementIds],
    nextGate: sanitizeLedgerValue(current.nextGate) as string,
    evidence: sanitizeLedgerValue(current.evidence) as CompletionCapsule["evidence"],
    blockers: sanitizeLedgerValue(current.blockers) as string[],
    residualRisks: sanitizeLedgerValue(current.residualRisks) as string[],
    createdAt: (() => {
      const safeTimestamp = sanitizeLedgerValue(createdAt);
      return typeof safeTimestamp === "string" && safeTimestamp.length > 0 ? safeTimestamp : "unknown";
    })(),
    truncated: changedBySanitization(current) || current.roadmap.length > MAX_COLLECTION_LENGTH || !validTimestamp(createdAt),
    ...(current.redTestReference !== undefined ? { redTestReference: sanitizeLedgerValue(current.redTestReference) as string } : {}),
    ...(current.tddWaiverReference !== undefined ? { tddWaiverReference: sanitizeLedgerValue(current.tddWaiverReference) as string } : {}),
    ...(current.scaleVerdict !== undefined ? { scaleVerdict: sanitizeLedgerValue(current.scaleVerdict) as string } : {}),
    ...(current.scaleWaiverReference !== undefined ? { scaleWaiverReference: sanitizeLedgerValue(current.scaleWaiverReference) as string } : {}),
    ...(current.changedScopeSummary !== undefined ? { changedScopeSummary: sanitizeLedgerValue(current.changedScopeSummary) as string } : {}),
  };
  // Remove optional/prose fields in a fixed order until the bounded capsule
  // fits. Required terminal facts remain, and accepted is only canonical.
  const optionalKeys: Array<keyof CompletionCapsule> = [
    "changedScopeSummary",
    "scaleWaiverReference",
    "scaleVerdict",
    "tddWaiverReference",
    "redTestReference",
    "residualRisks",
    "blockers",
    "evidence",
    "requirementIds",
    "roadmap",
  ];
  while (!fits(capsule) && optionalKeys.length > 0) {
    const key = optionalKeys.shift()!;
    if (key === "roadmap") capsule.roadmap = [];
    else if (key === "requirementIds") capsule.requirementIds = [];
    else if (key === "evidence") capsule.evidence = [];
    else if (key === "blockers") capsule.blockers = [];
    else if (key === "residualRisks") capsule.residualRisks = [];
    else delete capsule[key];
    capsule.truncated = true;
  }
  if (!fits(capsule)) {
    // Identity itself is required for a capsule but unlike an active
    // projection it may be bounded to a marker rather than dropped.
    capsule.workItemId = truncateUtf8(capsule.workItemId, 256);
    capsule.nextGate = truncateUtf8(capsule.nextGate, 256);
    capsule.truncated = true;
  }
  // The fields above are bounded independently; in combination they can
  // still exceed the cap. Use fixed required-field reductions as a final
  // fail-safe rather than ever persisting an oversized capsule.
  if (!fits(capsule)) {
    capsule.workItemId = TRUNCATED;
    capsule.nextGate = TRUNCATED;
    capsule.truncated = true;
  }
  return freezeDeep(capsule);
}
