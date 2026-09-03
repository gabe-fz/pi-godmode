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
/**
 * Conservative recovery cap: Pi's active branch is expected to be a short
 * session lineage, not an unbounded session history. Reject larger branches
 * before walking them so parent/ancestry work remains bounded.
 */
const MAX_ACTIVE_BRANCH_ENTRIES = 1_024;
/** Total own properties visited by append acknowledgement comparison. */
const MAX_EXACT_PERSISTED_ENTRIES = 1_024;
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

type ParentChainState = "visiting" | "valid" | "invalid";

interface BoundedBranchEntry {
  entry: SessionEntry;
  id: string;
  parentId: string | null;
}

interface BoundedBranchValidation {
  entries?: BoundedBranchEntry[];
  exceededLimit?: boolean;
}

/**
 * Capture and validate the complete active path before inspecting its payloads.
 *
 * SessionManager supplies an ordered root-to-leaf path. Do not infer that
 * shape from candidate snapshots: candidate-free paths must fail closed too.
 * Every host-controlled structural read is guarded and captured once, and the
 * fixed length/ID bounds keep all callers linear and bounded.
 */
function boundedActiveBranchEntries(entries: readonly SessionEntry[]): BoundedBranchValidation {
  try {
    if (!Array.isArray(entries)) return {};
    const entryCount = entries.length;
    if (!Number.isSafeInteger(entryCount) || entryCount < 0 || entryCount > MAX_ACTIVE_BRANCH_ENTRIES) {
      return { exceededLimit: true };
    }
    const ids = new Set<string>();
    const branch: BoundedBranchEntry[] = [];
    let expectedParentId: string | null = null;
    for (let index = 0; index < entryCount; index += 1) {
      const entry = entries[index];
      if (!entry || !isObject(entry)) return {};
      const id = entry.id;
      const parentId = entry.parentId;
      if (!validIdentity(id)
        || (parentId !== null && !validIdentity(parentId))
        || parentId !== expectedParentId
        || ids.has(id)) return {};
      ids.add(id);
      branch.push({ entry: entry as unknown as SessionEntry, id, parentId });
      expectedParentId = id;
    }
    return { entries: branch };
  } catch {
    return {};
  }
}

/**
 * Resolve parent links with memoized states. Each branch entry is visited at
 * most once while resolving all candidate chains, avoiding a per-candidate
 * full ancestry walk.
 */
function validParentChain(
  parentById: Map<string, string | null>,
  entryId: string,
  states: Map<string, ParentChainState>,
): boolean {
  const path: string[] = [];
  let currentId: string | null = entryId;
  while (currentId !== null) {
    const state = states.get(currentId);
    if (state === "valid") {
      for (const pathId of path) states.set(pathId, "valid");
      return true;
    }
    if (state === "invalid" || state === "visiting") {
      for (const pathId of path) states.set(pathId, "invalid");
      return false;
    }
    const parentId = parentById.get(currentId);
    if (parentId === undefined) {
      for (const pathId of path) states.set(pathId, "invalid");
      return false;
    }
    states.set(currentId, "visiting");
    path.push(currentId);
    currentId = parentId;
  }
  for (const pathId of path) states.set(pathId, "valid");
  return true;
}

interface AncestryInterval {
  start: number;
  end: number;
}

/**
 * Build constant-time ancestor intervals for the already-resolved candidate
 * forest. This keeps predecessor checks linear in the bounded branch size.
 */
function ancestryIntervals(
  parentById: Map<string, string | null>,
  states: Map<string, ParentChainState>,
): Map<string, AncestryInterval> {
  const validIds = [...states].filter(([, state]) => state === "valid").map(([id]) => id);
  const childrenByParent = new Map<string, string[]>();
  for (const id of validIds) {
    const parentId = parentById.get(id);
    if (parentId === undefined || parentId === null) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(id);
    childrenByParent.set(parentId, children);
  }
  const intervals = new Map<string, AncestryInterval>();
  let clock = 0;
  for (const rootId of validIds) {
    if (parentById.get(rootId) !== null || intervals.has(rootId)) continue;
    const stack: Array<{ id: string; exiting: boolean }> = [{ id: rootId, exiting: false }];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) continue;
      if (frame.exiting) {
        const interval = intervals.get(frame.id);
        if (interval) interval.end = clock;
        continue;
      }
      if (intervals.has(frame.id)) continue;
      intervals.set(frame.id, { start: clock, end: -1 });
      clock += 1;
      stack.push({ id: frame.id, exiting: true });
      const children = childrenByParent.get(frame.id);
      if (children) {
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const childId = children[index];
          if (childId !== undefined) stack.push({ id: childId, exiting: false });
        }
      }
    }
  }
  return intervals;
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
  try {
    return reconstructActiveSnapshotBounded(entries, sessionId, workItemId);
  } catch {
    return blocked("Malformed active branch lineage; recovery blocked.");
  }
}

function reconstructActiveSnapshotBounded(
  entries: readonly SessionEntry[],
  sessionId: string,
  workItemId: string,
): SnapshotRecovery {
  if (!validIdentity(sessionId) || !validIdentity(workItemId)) return blocked("Invalid session or work-item identity; recovery blocked.");
  const branchValidation = boundedActiveBranchEntries(entries);
  if (branchValidation.exceededLimit) return blocked("Active branch exceeds the bounded recovery limit; recovery blocked.");
  const branch = branchValidation.entries;
  if (!branch) return blocked("Malformed active branch lineage; recovery blocked.");
  const parentById = new Map<string, string | null>();
  for (const branchEntry of branch) parentById.set(branchEntry.id, branchEntry.parentId);
  const candidates: Array<{ entry: StoredLedgerEntry; entryId: string; snapshot: LedgerSnapshot }> = [];
  for (const branchEntry of branch) {
    const entry = branchEntry.entry;
    if (!isLedgerEntry(entry)) continue;
    const raw = entry.data;
    // Other work items may coexist in a session branch. A payload that cannot
    // identify its item is malformed; a well-formed different item is ignored.
    if (isObject(raw) && typeof raw.workItemId === "string" && raw.workItemId !== workItemId) continue;
    const safeRaw = sanitizeLedgerValue(raw);
    if (!isSnapshot(safeRaw)) return blocked("Invalid workflow ledger snapshot data; recovery blocked.");
    if (safeRaw.sessionId !== sessionId) return blocked("Cross-session workflow ledger snapshot; recovery blocked.");
    if (safeRaw.workItemId !== workItemId) return blocked("Workflow snapshot identity was altered by sanitization; recovery blocked.");
    candidates.push({ entry, entryId: branchEntry.id, snapshot: freezeDeep(safeRaw) });
  }
  if (candidates.length === 0) return { status: "absent" };

  const byGeneration = new Map<number, { entry: StoredLedgerEntry; entryId: string; snapshot: LedgerSnapshot }>();
  const candidateById = new Map<string, { entry: StoredLedgerEntry; entryId: string; snapshot: LedgerSnapshot }>();
  for (const candidate of candidates) {
    const prior = byGeneration.get(candidate.snapshot.generation);
    if (prior) return blocked("Conflicting duplicate workflow snapshot generation; recovery blocked.");
    byGeneration.set(candidate.snapshot.generation, candidate);
    candidateById.set(candidate.entryId, candidate);
  }
  const parentStates = new Map<string, ParentChainState>();
  for (const candidate of candidates) {
    if (!validParentChain(parentById, candidate.entryId, parentStates)) {
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
    }
  }
  const intervals = ancestryIntervals(parentById, parentStates);
  for (const candidate of candidates) {
    if (candidate.snapshot.generation === 1) continue;
    const predecessorId = candidate.snapshot.predecessorEntryId;
    if (predecessorId === null) return blocked("Workflow snapshot is missing its predecessor; recovery blocked.");
    const candidateInterval = intervals.get(candidate.entryId);
    const predecessorInterval = intervals.get(predecessorId);
    if (!candidateInterval || !predecessorInterval
      || predecessorInterval.start > candidateInterval.start
      || candidateInterval.end > predecessorInterval.end) {
      return blocked("Workflow snapshot predecessor is off-branch; recovery blocked.");
    }
  }
  let highest = candidates[0];
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate && highest && candidate.snapshot.generation > highest.snapshot.generation) highest = candidate;
  }
  if (!highest) return { status: "absent" };
  return { status: "ok", entryId: highest.entryId, snapshot: highest.snapshot };
}

/** The subset of ExtensionAPI needed to append a plain custom entry. */
interface LedgerAppender {
  appendEntry(customType: string, data?: unknown): void;
}

/** The public session getters needed to verify the active append lineage. */
interface LedgerSessionManager {
  getSessionId(): string;
  getBranch(): readonly SessionEntry[];
  getLeafEntry(): SessionEntry | undefined;
}

function appendBlocked(reason: string): never {
  throw new Error(`Workflow snapshot append blocked: ${reason}`);
}

/** Validate the branch shape before deriving any successor metadata. */
function validActiveBranch(entries: readonly SessionEntry[], leaf: SessionEntry | undefined): boolean {
  if (!Array.isArray(entries)) return false;
  const entryCount = entries.length;
  // Check the cap before touching any entry. This also prevents a hostile
  // array-like proxy from making validation iterate without a fixed bound.
  if (!Number.isSafeInteger(entryCount) || entryCount < 0 || entryCount > MAX_ACTIVE_BRANCH_ENTRIES) return false;
  const ids = new Set<string>();
  let parentId: string | null = null;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = entries[index];
    if (!entry
      || !isObject(entry)
      || !nonEmptyString(entry.id)
      || !nonEmptyString(entry.type)
      || !nonEmptyString(entry.timestamp)
      || (entry.parentId !== null && typeof entry.parentId !== "string")
      || entry.parentId !== parentId
      || ids.has(entry.id)) return false;
    ids.add(entry.id);
    parentId = entry.id;
  }
  if (entryCount === 0) return leaf === undefined;
  if (!isObject(leaf)
    || !nonEmptyString(leaf.id)
    || !nonEmptyString(leaf.type)
    || !nonEmptyString(leaf.timestamp)
    || (leaf.parentId !== null && typeof leaf.parentId !== "string")) return false;
  const branchLeaf = entries[entryCount - 1];
  return branchLeaf !== undefined
    && leaf.id === branchLeaf.id
    && leaf.parentId === branchLeaf.parentId;
}

interface ExactComparisonState {
  entries: number;
  leftPath: WeakSet<object>;
  rightPath: WeakSet<object>;
}

/**
 * Compare the persisted payload itself, rather than a re-sanitized value.
 *
 * A returned acknowledgement is host-controlled, so this comparator never
 * invokes a property getter: it reads only caught own-property descriptors.
 * It rejects accessors, cycles, excessive depth, oversized strings, and a
 * payload whose total own-property count exceeds the fixed comparison budget.
 */
function exactPersistedValue(left: unknown, right: unknown): boolean {
  const state: ExactComparisonState = {
    entries: 0,
    leftPath: new WeakSet<object>(),
    rightPath: new WeakSet<object>(),
  };

  const compare = (leftValue: unknown, rightValue: unknown, depth: number): boolean => {
    const leftObject = typeof leftValue === "object" && leftValue !== null;
    const rightObject = typeof rightValue === "object" && rightValue !== null;
    if (!leftObject || !rightObject) {
      if (typeof leftValue !== typeof rightValue) return false;
      if (typeof leftValue === "string" && byteLength(leftValue) > MAX_STRING_LENGTH) return false;
      // The canonical snapshot contains no executable or symbol values.
      if (typeof leftValue === "function" || typeof leftValue === "symbol") return false;
      return Object.is(leftValue, rightValue);
    }
    let enteredPath = false;
    try {
      if (Array.isArray(leftValue) !== Array.isArray(rightValue)) return false;
      if (depth >= MAX_DEPTH) return false;
      if (state.leftPath.has(leftValue) || state.rightPath.has(rightValue)) return false;
      state.leftPath.add(leftValue);
      state.rightPath.add(rightValue);
      enteredPath = true;
      if (Object.getPrototypeOf(leftValue) !== Object.getPrototypeOf(rightValue)) return false;
      const leftKeys = Reflect.ownKeys(leftValue);
      const rightKeys = Reflect.ownKeys(rightValue);
      if (leftKeys.length > MAX_COLLECTION_LENGTH
        || rightKeys.length > MAX_COLLECTION_LENGTH
        || leftKeys.length !== rightKeys.length) return false;
      const leftKeySet = new Set<PropertyKey>(leftKeys);
      const rightKeySet = new Set<PropertyKey>(rightKeys);
      if (leftKeySet.size !== leftKeys.length || rightKeySet.size !== rightKeys.length) return false;
      for (const key of leftKeys) if (!rightKeySet.has(key)) return false;
      state.entries += leftKeys.length;
      if (state.entries > MAX_EXACT_PERSISTED_ENTRIES) return false;
      for (const key of leftKeys) {
        const leftDescriptor = Object.getOwnPropertyDescriptor(leftValue, key);
        const rightDescriptor = Object.getOwnPropertyDescriptor(rightValue, key);
        if (!leftDescriptor || !rightDescriptor
          || leftDescriptor.get !== undefined
          || leftDescriptor.set !== undefined
          || rightDescriptor.get !== undefined
          || rightDescriptor.set !== undefined
          || leftDescriptor.enumerable !== rightDescriptor.enumerable
          || !("value" in leftDescriptor)
          || !("value" in rightDescriptor)
          || !compare(leftDescriptor.value, rightDescriptor.value, depth + 1)) return false;
      }
      return true;
    } catch {
      return false;
    } finally {
      if (enteredPath) {
        state.leftPath.delete(leftValue);
        state.rightPath.delete(rightValue);
      }
    }
  };

  return compare(left, right, 0);
}

/** Copy only a bounded active branch; never consume a host-provided iterator. */
function copyBoundedActiveBranch(entries: readonly SessionEntry[]): readonly SessionEntry[] {
  if (!Array.isArray(entries)) return entries;
  const entryCount = entries.length;
  if (!Number.isSafeInteger(entryCount) || entryCount < 0 || entryCount > MAX_ACTIVE_BRANCH_ENTRIES) return entries;
  const copy: SessionEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    copy.push(entries[index]!);
  }
  return copy;
}

/**
 * Append one sanitized canonical snapshot and verify Pi advanced the active
 * branch to the expected plain custom entry. This intentionally does not use
 * custom messages or any context-injection API.
 */
export function appendWorkflowSnapshot(
  pi: LedgerAppender,
  sessionManager: LedgerSessionManager,
  record: WorkflowRecord,
  createdAt: string,
): { entryId: string; snapshot: LedgerSnapshot } {
  let sessionId: string;
  let branch: readonly SessionEntry[];
  let priorLeaf: SessionEntry | undefined;
  try {
    sessionId = sessionManager.getSessionId();
    const activeBranch = sessionManager.getBranch();
    // Keep a pre-append copy: structural callers may expose their backing
    // array directly even though Pi's public getter currently returns a new
    // path array. Avoid consuming a potentially hostile custom iterator.
    branch = copyBoundedActiveBranch(activeBranch);
    priorLeaf = sessionManager.getLeafEntry();
  } catch {
    appendBlocked("Unable to read session identity or active branch lineage.");
  }
  if (!validIdentity(sessionId)) appendBlocked("Session identity is invalid.");

  let branchIsValid = false;
  try {
    branchIsValid = validActiveBranch(branch, priorLeaf);
  } catch {
    appendBlocked("Unable to read active branch lineage; append blocked.");
  }
  if (!branchIsValid) appendBlocked("Active branch lineage is malformed or inconsistent.");

  let priorLeafId: string | null = null;
  let branchIds: Set<string>;
  try {
    priorLeafId = priorLeaf?.id ?? null;
    branchIds = new Set(branch.map((entry) => entry.id));
  } catch {
    appendBlocked("Unable to read active branch lineage; append blocked.");
  }

  const validation = validateWorkflowRecord(record);
  if (!validation.ok) appendBlocked(validation.reason);
  const canonicalRecord = validation.record;
  const recovery = reconstructActiveSnapshot(branch, sessionId, canonicalRecord.workItemId);
  if (recovery.status === "blocked") appendBlocked(recovery.reason);

  const generation = recovery.status === "absent" ? 1 : recovery.snapshot.generation + 1;
  if (!Number.isSafeInteger(generation)) appendBlocked("Workflow snapshot generation exhausted.");
  const predecessorEntryId = recovery.status === "absent" ? null : recovery.entryId;
  const snapshot = createLedgerSnapshot({
    sessionId,
    workItemId: canonicalRecord.workItemId,
    generation,
    predecessorEntryId,
    createdAt,
    record: canonicalRecord,
  });

  // ExtensionAPI.appendEntry is synchronous and returns no entry ID. Do not
  // inspect or await a return value; the leaf check below is the commit
  // acknowledgement and fail-closed boundary.
  try {
    pi.appendEntry(LEDGER_CUSTOM_TYPE, snapshot);
  } catch {
    appendBlocked("Unable to append the workflow snapshot.");
  }

  let acknowledgedEntryId: string | undefined;
  try {
    const newLeaf = sessionManager.getLeafEntry();
    if (isObject(newLeaf) && isLedgerEntry(newLeaf)) {
      // Capture every host-controlled property once, inside this boundary.
      // The return path must not re-read a getter that changed after verify.
      const leafId = newLeaf.id;
      const leafTimestamp = newLeaf.timestamp;
      const leafParentId = newLeaf.parentId;
      const leafData = newLeaf.data;
      if (nonEmptyString(leafId)
        && nonEmptyString(leafTimestamp)
        && leafId !== priorLeafId
        && !branchIds.has(leafId)
        && leafParentId === priorLeafId
        && exactPersistedValue(leafData, snapshot)) {
        acknowledgedEntryId = leafId;
      }
    }
  } catch {
    appendBlocked("Unable to verify the appended active-branch leaf.");
  }
  if (acknowledgedEntryId === undefined) {
    appendBlocked("Appended leaf does not match the expected custom snapshot or active ancestry.");
  }
  return { entryId: acknowledgedEntryId, snapshot };
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
