import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { DoctorReport } from "./types.ts";
import { containsActiveContent, containsSecretLikeContent, redactSecretLikeContent, scavengeGodmodeTempDirectories } from "./security-text.ts";

/** Phase 6 deliberately has a smaller write surface than the discovery tree. */
export const DOCTOR_APPLY_PROFILE_PATH = ".godmode/validation-profile.json" as const;
export const DOCTOR_APPLY_GUIDANCE_PATH = "docs/GODMODE_WORKFLOW.md" as const;
export const DOCTOR_APPLY_PATHS = [DOCTOR_APPLY_PROFILE_PATH, DOCTOR_APPLY_GUIDANCE_PATH] as const;
export const DOCTOR_APPLY_TOKEN_BYTES = 32;
export const DOCTOR_APPLY_TOKEN_TTL_MS = 5 * 60 * 1000;
export const DOCTOR_APPLY_MAX_PREVIEWS = 8;
export const DOCTOR_APPLY_MAX_RECOVERIES = 8;
export const DOCTOR_APPLY_MAX_BACKUP_BYTES = 1024 * 1024;
export const DOCTOR_APPLY_MAX_HINTS = 4;
export const DOCTOR_APPLY_MAX_HINT_BYTES = 160;
export const DOCTOR_APPLY_MAX_SERIALIZED_BYTES = 32 * 1024;
/** Recovery backups use the shared bounded temp policy and explicit lifecycle cleanup. */
export const DOCTOR_RECOVERY_DIRECTORY_PREFIX = "godmode-doctor-recovery-";

const MAX_TARGET_BYTES = 256 * 1024;
const CHECKBOX = /^\s*(?:[-*+]\s*)?\[([ xX])\]\s+(.+)$/u;
const STATUS_LINE = /^\s*(?:(?:status|state|todo|task|checklist)\s*[:\-]\s+)(.+)$/iu;
const SAFE_TOKEN = /^[0-9a-f]{64}$/u;

export type DoctorApplyMode = "create" | "replace";

export interface DoctorApplyFileSystem {
  /** The synchronous process seam is required for pinning a parent inode
   * during the final no-follow checks and mutation. */
  cwd(): string;
  chdir(path: string): void;
  lstatSync(path: string): fs.Stats;
  realpathSync(path: string): string;
  mkdirSync(path: string, options?: fs.MakeDirectoryOptions & { recursive?: false }): void;
  openSync(path: string, flags: number, mode?: number): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  writeSync(fd: number, buffer: Buffer, offset?: number, length?: number, position?: number): number;
  fstatSync(fd: number): fs.Stats;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  linkSync(existingPath: string, newPath: string): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  rmdirSync(path: string): void;
  chmodSync(path: string, mode: fs.Mode): void;
  mkdtempSync(prefix: string): string;
}

type ApplyFsOverrides = Partial<DoctorApplyFileSystem>;

function makeFileSystem(overrides: ApplyFsOverrides = {}): DoctorApplyFileSystem {
  return {
    cwd: overrides.cwd ?? (() => process.cwd()),
    chdir: overrides.chdir ?? ((path) => process.chdir(path)),
    lstatSync: overrides.lstatSync ?? ((path) => fs.lstatSync(path)),
    realpathSync: overrides.realpathSync ?? ((path) => fs.realpathSync(path)),
    mkdirSync: overrides.mkdirSync ?? ((path, options) => { fs.mkdirSync(path, options); }),
    openSync: overrides.openSync ?? ((path, flags, mode) => fs.openSync(path, flags, mode)),
    readSync: overrides.readSync ?? ((fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position)),
    writeSync: overrides.writeSync ?? ((fd, buffer, offset, length, position) => fs.writeSync(fd, buffer, offset, length, position)),
    fstatSync: overrides.fstatSync ?? ((fd) => fs.fstatSync(fd)),
    fsyncSync: overrides.fsyncSync ?? ((fd) => fs.fsyncSync(fd)),
    closeSync: overrides.closeSync ?? ((fd) => fs.closeSync(fd)),
    linkSync: overrides.linkSync ?? ((source, target) => fs.linkSync(source, target)),
    renameSync: overrides.renameSync ?? ((source, target) => fs.renameSync(source, target)),
    unlinkSync: overrides.unlinkSync ?? ((path) => fs.unlinkSync(path)),
    rmdirSync: overrides.rmdirSync ?? ((path) => fs.rmdirSync(path)),
    chmodSync: overrides.chmodSync ?? ((path, mode) => fs.chmodSync(path, mode)),
    mkdtempSync: overrides.mkdtempSync ?? ((prefix) => fs.mkdtempSync(prefix)),
  };
}

export interface DoctorApplyTargetSnapshot {
  exists: boolean;
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
  hash?: string;
}

export interface DoctorLegacyHint {
  id: string;
  source: string;
  text: string;
  kind: "checkbox" | "status" | "json";
  checked?: boolean;
  hash: string;
  basis: "observed";
  confidence: "medium" | "low";
  requiresExplicitApproval: true;
}

export interface DoctorApplyOperation {
  path: (typeof DOCTOR_APPLY_PATHS)[number];
  absolutePath: string;
  mode: DoctorApplyMode;
  content: string;
  contentHash: string;
  parent: DoctorApplyTargetSnapshot;
  target: DoctorApplyTargetSnapshot;
  proposedDiff: string;
}

export interface DoctorApplyConflict {
  path: (typeof DOCTOR_APPLY_PATHS)[number];
  reason: string;
  target: DoctorApplyTargetSnapshot;
}

export interface DoctorApplyPreview {
  schema: "godmode-doctor-apply";
  schemaVersion: 1;
  root: { path: string; dev: number; ino: number };
  mode: DoctorApplyMode;
  token: string;
  expiresAt: number;
  digest: string;
  operations: DoctorApplyOperation[];
  conflicts: DoctorApplyConflict[];
  legacyHints: DoctorLegacyHint[];
  proposedDiff: string;
  /** True means no project mutation occurred while producing this preview. */
  readOnly: true;
  /** The preview can be explicitly confirmed, unlike runDoctor's report. */
  applyAvailable: true;
  rendered: string;
}

export interface DoctorApplyResult {
  schema: "godmode-doctor-apply-result";
  schemaVersion: 1;
  status: "applied" | "partial" | "conflict" | "denied" | "error";
  applied: string[];
  failed: Array<{ path: string; reason: string }>;
  warnings: string[];
  recoveryToken?: string;
  operations: Array<{ path: string; status: "applied" | "failed"; reason?: string }>;
  rendered: string;
}

export interface DoctorApplyRecoveryResult {
  schema: "godmode-doctor-apply-recovery-result";
  schemaVersion: 1;
  status: "recovered" | "refused" | "denied" | "error";
  path?: string;
  reason?: string;
  /** A failed recovery retains this same process-local handle until expiry so
   * the user can retry after an unproven rename, verification, or cwd restore. */
  recoveryToken?: string;
  rendered: string;
}

export interface DoctorApplyOptions {
  replacePath?: string;
  /** Compatibility spellings for command adapters. */
  replacementPath?: string;
  path?: string;
  replace?: string;
  replacement?: string;
  /** Direct API callers may provide the host idle decision. */
  isIdle?: boolean;
  idle?: boolean;
  now?: () => number;
  trusted?: boolean;
  /** Explicit host proof that no Divine Faculty is active. Omission is not proof. */
  activeFaculty?: string | null;
  fs?: ApplyFsOverrides;
  fileSystem?: ApplyFsOverrides;
  filesystem?: ApplyFsOverrides;
  manager?: DoctorApplyManager;
  /** Test seam invoked after preflight and immediately before an operation. */
  beforeWrite?: (operation: DoctorApplyOperation, index: number) => void;
  [key: string]: unknown;
}

export function scavengeDoctorRecoveryDirectories(): number {
  return scavengeGodmodeTempDirectories();
}
export const scavengeDoctorRecoveryArtifacts = scavengeDoctorRecoveryDirectories;

export class DoctorApplyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DoctorApplyError";
    this.code = code;
  }
}

interface RootSnapshot {
  path: string;
  dev: number;
  ino: number;
}

interface PreviewEntry {
  preview: DoctorApplyPreview;
  root: RootSnapshot;
  createdAt: number;
  operations: DoctorApplyOperation[];
  hintHashes: string[];
}

interface CwdBinding {
  path: string;
  identity: DoctorApplyTargetSnapshot;
}

interface PinnedCommitProof {
  readonly kind: "doctor-apply-commit-proof";
  readonly path: string;
  readonly target: DoctorApplyTargetSnapshot;
}

function isPinnedCommitProof(value: unknown): value is PinnedCommitProof {
  return Boolean(value && typeof value === "object"
    && (value as { kind?: unknown }).kind === "doctor-apply-commit-proof"
    && typeof (value as { path?: unknown }).path === "string"
    && (value as { target?: unknown }).target !== undefined);
}

class CwdRestorationError extends DoctorApplyError {
  readonly restoreCwd: CwdBinding;
  constructor(message: string, restoreCwd: CwdBinding) {
    super("cwd", message);
    this.name = "CwdRestorationError";
    this.restoreCwd = restoreCwd;
  }
}

/** A pinned write completed and its exact target was verified, but the process
 * cwd could not be restored. The result must report that write as applied and
 * stop before another operation can run. */
class PostCommitRestorationError extends CwdRestorationError {
  readonly appliedPath: string;
  readonly appliedTarget: DoctorApplyTargetSnapshot;
  constructor(message: string, restoreCwd: CwdBinding, proof: PinnedCommitProof) {
    super(message, restoreCwd);
    this.name = "PostCommitRestorationError";
    this.appliedPath = proof.path;
    this.appliedTarget = proof.target;
  }
}

interface RecoveryEntry {
  token: string;
  root: RootSnapshot;
  operation: DoctorApplyOperation;
  backupPath: string;
  backupDirectory: string;
  backupHash: string;
  /** The generated target identity, captured after replacement. A fallback
   * content binding is retained when an injected post-write failure prevents
   * complete metadata capture; recovery still refuses any content mutation. */
  generated: DoctorApplyTargetSnapshot;
  parent: DoctorApplyTargetSnapshot;
  /** If cwd restoration failed, retry the recovery against the original cwd
   * proof rather than treating the failed pinned parent as the new baseline. */
  restoreCwd?: CwdBinding;
  expiresAt: number;
}

/** A replacement may have committed before a later fsync/verification step
 * failed. The entry is carried to the result so the only verified backup is
 * never discarded when automatic rollback cannot be proven. */
class ReplacementFailure extends DoctorApplyError {
  readonly recovery?: RecoveryEntry;
  readonly appliedPath?: string;
  readonly appliedTarget?: DoctorApplyTargetSnapshot;
  constructor(code: string, message: string, recovery?: RecoveryEntry, proof?: PinnedCommitProof) {
    super(code, message);
    this.name = "ReplacementFailure";
    this.recovery = recovery;
    this.appliedPath = proof?.path;
    this.appliedTarget = proof?.target;
  }
}

/** chdir() changes process state, so this guard is intentionally module-wide,
 * synchronous, and shared by every manager instance in this process. */
let processCwdGuardHeld = false;

function bounded(value: string, maximum: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maximum) break;
    result += character;
  }
  return result;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function redact(value: string, maximum = 160): string {
  let result = value.replace(/(-----BEGIN [^-]*PRIVATE KEY-----)[\s\S]*?(-----END [^-]*PRIVATE KEY-----)/giu, "$1[REDACTED]$2");
  result = result.replace(/\bBearer\s+[^\s'"`]+/giu, "Bearer [REDACTED]");
  result = result.replace(/\b(?:token|password|passwd|secret|api[_-]?key|client[_-]?secret|authorization)\s*([=:])\s*[^\s;&|]+/giu, (_match, separator: string) => `${_match.slice(0, _match.indexOf(separator))}${separator}[REDACTED]`);
  return bounded(result, maximum);
}

function sameIdentity(left: DoctorApplyTargetSnapshot, right: DoctorApplyTargetSnapshot): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.hash === right.hash;
}

function sameRoot(left: RootSnapshot, right: RootSnapshot): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino;
}

/** Directory mtime/size legitimately changes when an allowed child is
 * created/replaced. Parent binding therefore uses its no-follow identity only. */
function sameParent(left: DoctorApplyTargetSnapshot, right: DoctorApplyTargetSnapshot): boolean {
  return left.exists === right.exists && (!left.exists || (left.dev === right.dev && left.ino === right.ino));
}

/** Match a recovery target against only the fields that were provable when
 * the handle was issued. Normal handles bind content and metadata; the narrow
 * post-commit fallback may bind regular-file identity when content verification
 * itself was the failed step. */
function sameRecoveryTarget(left: DoctorApplyTargetSnapshot, right: DoctorApplyTargetSnapshot): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  if (right.hash !== undefined && left.hash !== right.hash) return false;
  if (right.hash === undefined && (right.dev === undefined || right.ino === undefined)) return false;
  return (right.dev === undefined || left.dev === right.dev)
    && (right.ino === undefined || left.ino === right.ino)
    && (right.size === undefined || left.size === right.size)
    && (right.mtimeMs === undefined || left.mtimeMs === right.mtimeMs);
}

function sameCommitTarget(left: DoctorApplyTargetSnapshot, right: DoctorApplyTargetSnapshot): boolean {
  return left.exists && right.exists && left.dev === right.dev && left.ino === right.ino;
}

function relativeSafe(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !value.includes("\0"));
}

function targetPath(root: string, path: string): string {
  if (!(DOCTOR_APPLY_PATHS as readonly string[]).includes(path)) throw new DoctorApplyError("path", "Only the two documented Godmode targets are writable.");
  const absolute = resolve(root, ...path.split("/"));
  if (!relativeSafe(root, absolute) || path.includes("\\") || path.includes("\0")) throw new DoctorApplyError("path", "The apply path is outside the selected project.");
  return absolute;
}

function rootSnapshot(root: string, fileSystem: DoctorApplyFileSystem): RootSnapshot {
  const requested = resolve(root);
  let initial: fs.Stats;
  let canonical: string;
  try {
    initial = fileSystem.lstatSync(requested);
    if (initial.isSymbolicLink() || !initial.isDirectory()) throw new Error("not a directory");
    canonical = fileSystem.realpathSync(requested);
    const final = fileSystem.lstatSync(canonical);
    if (final.isSymbolicLink() || !final.isDirectory()) throw new Error("not a canonical directory");
    return { path: canonical, dev: Number(final.dev), ino: Number(final.ino) };
  } catch {
    throw new DoctorApplyError("root", "The selected project is not a safe readable directory.");
  }
}

function assertParentNoFollow(path: string, fileSystem: DoctorApplyFileSystem): void {
  const parent = dirname(path);
  try {
    const stat = fileSystem.lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DoctorApplyError("unsafe-parent", `Refusing symlinked or non-directory target parent: ${parent}`);
    // Resolve to prove the complete existing parent chain is readable. The
    // canonical spelling may differ from the lexical spelling on hosts where
    // /var is an OS alias; the root itself is already canonicalized.
    fileSystem.realpathSync(parent);
  } catch (error) {
    if (error instanceof DoctorApplyError) throw error;
    // A missing parent is handled as an explicit bounded create operation;
    // callers still recheck it immediately before mkdir/link/rename. Other
    // lstat failures are denied rather than treated as an absent directory.
    if (isMissing(error)) {
      try { fileSystem.lstatSync(parent); }
      catch (retryError) {
        if (isMissing(retryError)) return;
      }
    }
    throw new DoctorApplyError("unsafe-parent", `Target parent could not be safely resolved: ${parent}`);
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR"));
}

function lstatSnapshot(path: string, fileSystem: DoctorApplyFileSystem): DoctorApplyTargetSnapshot {
  let stat: fs.Stats;
  try {
    stat = fileSystem.lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return { exists: false };
    throw new DoctorApplyError("stat", `Target could not be safely inspected: ${path}`);
  }
  if (stat.isSymbolicLink()) throw new DoctorApplyError("unsafe-target", `Refusing symbolic link target or parent: ${path}`);
  if (!stat.isFile() && !stat.isDirectory()) throw new DoctorApplyError("unsafe-target", `Refusing non-regular target or parent: ${path}`);
  return {
    exists: true,
    dev: Number(stat.dev), ino: Number(stat.ino), size: Number(stat.size), mtimeMs: Number(stat.mtimeMs),
  };
}

function readRegular(path: string, expected: DoctorApplyTargetSnapshot, fileSystem: DoctorApplyFileSystem): { data: Buffer; snapshot: DoctorApplyTargetSnapshot } {
  if (!expected.exists) throw new DoctorApplyError("read", `Expected file does not exist: ${path}`);
  assertParentNoFollow(path, fileSystem);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    const before = fileSystem.lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_TARGET_BYTES) throw new Error("unsafe file");
    fd = fileSystem.openSync(path, fsConstants.O_RDONLY | noFollow);
    const opened = fileSystem.fstatSync(fd);
    if (!opened.isFile() || Number(opened.dev) !== expected.dev || Number(opened.ino) !== expected.ino) throw new Error("file identity changed");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < Number(opened.size)) {
      const length = Math.min(16 * 1024, Number(opened.size) - total);
      const chunk = Buffer.allocUnsafe(length);
      const count = fileSystem.readSync(fd, chunk, 0, length, total);
      if (count <= 0) break;
      if (count > length) throw new Error("invalid read");
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    const after = fileSystem.fstatSync(fd);
    if (!after.isFile() || Number(after.dev) !== Number(opened.dev) || Number(after.ino) !== Number(opened.ino) || Number(after.size) !== total) throw new Error("file changed while reading");
    const data = Buffer.concat(chunks);
    const snapshot: DoctorApplyTargetSnapshot = {
      exists: true, dev: Number(after.dev), ino: Number(after.ino), size: Number(after.size),
      mtimeMs: Number(after.mtimeMs), hash: hash(data),
    };
    return { data, snapshot };
  } catch (error) {
    throw new DoctorApplyError("read", `Target changed or could not be safely read: ${path}${error instanceof Error ? ` (${error.message})` : ""}`);
  } finally {
    if (fd !== undefined) {
      try { fileSystem.closeSync(fd); } catch { /* close is best effort after a failed read */ }
    }
  }
}

function snapshotWithHash(path: string, expected: DoctorApplyTargetSnapshot, fileSystem: DoctorApplyFileSystem): DoctorApplyTargetSnapshot {
  if (!expected.exists) return { exists: false };
  const value = lstatSnapshot(path, fileSystem);
  if (!value.exists || !value.dev || !sameIdentity({ ...value, hash: expected.hash }, expected)) {
    // The hash is intentionally read only after metadata/identity comparison.
    if (value.dev !== expected.dev || value.ino !== expected.ino || value.size !== expected.size || value.mtimeMs !== expected.mtimeMs) return value;
  }
  return readRegular(path, expected, fileSystem).snapshot;
}

function canonicalHint(source: string, text: string, kind: DoctorLegacyHint["kind"], checked?: boolean): DoctorLegacyHint {
  const safeText = bounded(text.replace(/[\r\n]+/gu, " ").trim(), DOCTOR_APPLY_MAX_HINT_BYTES);
  const identity = `${source}\0${kind}\0${checked === undefined ? "" : checked ? "1" : "0"}\0${safeText}`;
  return {
    id: `legacy-${hash(identity).slice(0, 16)}`, source, text: safeText, kind,
    ...(checked === undefined ? {} : { checked }), hash: hash(identity), basis: "observed", confidence: "medium", requiresExplicitApproval: true,
  };
}

function hintFromText(source: string, value: string): DoctorLegacyHint[] {
  // Private-key and binary payloads are rejected as a whole. Ordinary
  // credential-bearing lines are filtered below so a safe adjacent checklist
  // hint remains useful without copying authority material.
  if (Buffer.byteLength(value, "utf8") > MAX_TARGET_BYTES || value.includes("\0") || /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/iu.test(value) || /\uFFFD/u.test(value)) return [];
  const result: DoctorLegacyHint[] = [];
  for (const line of value.split(/\r?\n/u).slice(0, 512)) {
    const checkbox = line.match(CHECKBOX);
    if (checkbox?.[2]) {
      const text = checkbox[2].trim();
      if (text && !containsSecretLikeContent(text) && !containsActiveContent(text)) result.push(canonicalHint(source, text, "checkbox", checkbox[1]?.toLowerCase() === "x"));
      continue;
    }
    const status = line.match(STATUS_LINE);
    if (status?.[1]) {
      const text = status[1].trim();
      if (text && !containsSecretLikeContent(text) && !containsActiveContent(text)) result.push(canonicalHint(source, text, "status"));
    }
  }
  return result;
}

function jsonHintValues(source: string, value: unknown, output: DoctorLegacyHint[], depth = 0): void {
  if (output.length >= DOCTOR_APPLY_MAX_HINTS || depth > 5) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text && text.length <= DOCTOR_APPLY_MAX_HINT_BYTES && !containsSecretLikeContent(text) && !containsActiveContent(text)) output.push(canonicalHint(source, text, "json"));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, DOCTOR_APPLY_MAX_HINTS)) jsonHintValues(source, item, output, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
      // Key names are untrusted input too. Skip all credential/private-key,
      // cookie, signed-URL, and execution-bearing names before visiting values.
      if (/(?:authorization|bearer|cookie|set[-_]?cookie|token|secret|password|passwd|passphrase|credential|private[-_ ]?key|api[-_ ]?key|access[-_ ]?(?:key|token)|refresh[-_ ]?token|id[-_ ]?token|command|script|exec|shell)/iu.test(key)) continue;
      jsonHintValues(source, item, output, depth + 1);
      if (output.length >= DOCTOR_APPLY_MAX_HINTS) return;
    }
  }
}

function collectLegacyHints(root: string, fileSystem: DoctorApplyFileSystem): DoctorLegacyHint[] {
  const paths = ["PROJECT_MEMORY.md", "CHECKLIST.md", "TODO.md", "STATUS.md", ".godmode/checklist.json"];
  const output: DoctorLegacyHint[] = [];
  for (const path of paths) {
    if (output.length >= DOCTOR_APPLY_MAX_HINTS) break;
    const absolute = resolve(root, ...path.split("/"));
    let state: DoctorApplyTargetSnapshot;
    try {
      assertParentNoFollow(absolute, fileSystem);
      state = lstatSnapshot(absolute, fileSystem);
    } catch { continue; }
    if (!state.exists) continue;
    try {
      const read = readRegular(absolute, state, fileSystem).data;
      const text = read.toString("utf8");
      if (path.endsWith(".json")) {
        try { jsonHintValues(path, JSON.parse(text), output); } catch { /* malformed legacy data is ignored */ }
      } else output.push(...hintFromText(path, text));
    } catch {
      // Legacy files are optional, untrusted data. A race or malformed source
      // must never block the rest of a bounded preview.
    }
  }
  const unique = new Map<string, DoctorLegacyHint>();
  for (const item of output) if (!unique.has(item.hash)) unique.set(item.hash, item);
  return [...unique.values()].sort((left, right) => `${left.source}\0${left.hash}`.localeCompare(`${right.source}\0${right.hash}`)).slice(0, DOCTOR_APPLY_MAX_HINTS);
}

function safeGeneratedText(value: unknown, maximum: number): string {
  const text = redactSecretLikeContent(String(value));
  return containsSecretLikeContent(text) || containsActiveContent(text) ? "[REDACTED]" : bounded(text, maximum);
}

function reportData(report: DoctorReport): Record<string, unknown> {
  const fallback = {
    projectTypes: report.projectTypes.length, surfaces: report.surfaces.length, testCandidates: report.testCandidates.length,
    commands: report.commands.length, docsConfig: report.docsConfig.length, verificationNeeds: report.verificationNeeds.length,
    gaps: report.gaps.length, safetyFindings: report.safetyFindings.length, proposals: report.proposals.length,
  };
  const count = (value: unknown, defaultValue: number): number => typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER) : defaultValue;
  const supplied = report.summary;
  const summary = {
    projectTypes: count(supplied?.projectTypes, fallback.projectTypes),
    surfaces: count(supplied?.surfaces, fallback.surfaces),
    testCandidates: count(supplied?.testCandidates, fallback.testCandidates),
    commands: count(supplied?.commands, fallback.commands),
    docsConfig: count(supplied?.docsConfig, fallback.docsConfig),
    verificationNeeds: count(supplied?.verificationNeeds, fallback.verificationNeeds),
    gaps: count(supplied?.gaps, fallback.gaps),
    safetyFindings: count(supplied?.safetyFindings, fallback.safetyFindings),
    proposals: count(supplied?.proposals, fallback.proposals),
  };
  return {
    summary,
    projectTypes: report.projectTypes.slice(0, 8).map((item) => safeGeneratedText(item.type, 96)),
    surfaces: report.surfaces.slice(0, 8).map((item) => safeGeneratedText(item.surface, 96)),
    verificationNeeds: report.verificationNeeds.slice(0, 8).map((item) => ({ surface: safeGeneratedText(item.surface, 96), method: safeGeneratedText(item.method, 96) })),
    commands: report.commands.slice(0, 4).map((item) => ({ command: safeGeneratedText(item.command, 160), sourcePath: safeGeneratedText(item.sourcePath, 96), requiresExplicitApproval: true })),
  };
}

function generateContents(report: DoctorReport, hints: DoctorLegacyHint[]): { profile: string; guidance: string } {
  const data = reportData(report);
  const profileObject = {
    schema: "godmode-validation-profile",
    schemaVersion: 1,
    authoritative: false,
    notice: "Discovered commands and legacy hints are non-authoritative data and require explicit approval.",
    policy: {
      redTests: "Required before Hand for executable feature/bugfix work; a narrow compensated TDD waiver is explicit.",
      scale: "Mandatory before Primary acceptance; only a narrow Primary-recorded user or policy waiver applies.",
      evidenceMethods: {
        "browser-ui": "real-browser-flow", tui: "deterministic-pty", api: "controlled-request", cli: "executable-invocation",
        library: "downstream-consumer", "persistence-migration": "disposable-storage", "build-config": "supported-build-config-check", documentation: "rendered-doc-validation",
      },
      applicability: "Record applicable or a bounded not-applicable placeholder for every requirement/surface pair.",
      redaction: "Reject or filter credentials, bearer/cookie values, passwords, private keys, signed URLs, cloud credentials, and active content; raw artifacts/transcripts are not persisted.",
      retention: "Use bounded session, review, or durable retention; expiry makes artifacts unusable, while explicit lifecycle cleanup handles currently held references. Crash leftovers defer to host OS temporary retention because pathname cleanup is not race-safe in this runtime.",
      acceptance: "Primary-only acceptance; legacy hints and discovered commands remain non-authoritative and inert.",
    },
    discovered: data,
    candidateHints: hints,
  };
  const profile = `${JSON.stringify(profileObject, null, 2)}\n`;
  const lines = [
    "# Godmode workflow guidance",
    "",
    "> Generated from bounded static discovery. Discovered commands and legacy hints are non-authoritative data; nothing here is executed or imported.",
    "",
    "## Discovered summary",
    `- Project types: ${(data.projectTypes as string[]).join(", ") || "none"}`,
    `- Interface surfaces: ${(data.surfaces as string[]).join(", ") || "none"}`,
    "",
    "## Candidate hints (untrusted; explicit approval required)",
  ];
  if (hints.length === 0) lines.push("- None discovered.");
  else for (const hint of hints) lines.push(`- [${hint.checked === true ? "x" : hint.checked === false ? " " : "candidate"}] ${hint.text} _(source: ${hint.source}; hash: ${hint.hash.slice(0, 16)})_`);
  lines.push("", "## Commands (inert observations; explicit approval required)");
  const commands = data.commands as Array<{ command: string; sourcePath: string }>;
  if (commands.length === 0) lines.push("- None discovered.");
  else for (const command of commands) lines.push(`- ${command.command} _(source: ${command.sourcePath}; not executed)_`);
  lines.push(
    "",
    "## Required Godmode policy",
    "- Red tests are required before Hand for executable feature/bugfix work; only a narrow documented TDD waiver with compensation can replace them.",
    "- Scale review is mandatory before acceptance for feature/bugfix work; only a Primary-recorded user or narrow policy waiver can replace it.",
    "- Evidence method map: browser-ui=real-browser-flow; tui=deterministic-pty; api=controlled-request; cli=executable-invocation; library=downstream-consumer; persistence-migration=disposable-storage; build-config=supported-build-config-check; documentation=rendered-doc-validation.",
    "- Every surface is applicable or has a bounded Primary-authored not-applicable reason; unsupported surfaces use an applicability placeholder, never a pretend check.",
    "- Redact credentials, bearer/cookie tokens, passwords, private keys, signed URLs, cloud credentials, and active content before retention; raw artifacts/transcripts are not persisted in workflow state.",
    "- Evidence is bounded and expires according to its retention class; active references are explicitly cleaned, while crash leftovers defer to host OS temporary retention because automatic pathname deletion is not race-safe in this runtime.",
    "- Only the Primary can verify, accept, or communicate completion. Legacy hints and discovered commands are non-authoritative and inert until explicitly approved.",
  );
  lines.push("");
  return { profile, guidance: lines.join("\n") };
}

function unifiedDiff(path: string, content: string, existing: Buffer | undefined, mode: DoctorApplyMode): string {
  let oldLines: string[] = [];
  if (existing !== undefined) {
    const oldText = existing.toString("utf8");
    oldLines = !oldText.includes("\0") && !containsSecretLikeContent(oldText) && !/\uFFFD/u.test(oldText)
      ? bounded(oldText, 8 * 1024).replace(/\n$/u, "").split("\n")
      : ["[existing content redacted; target identity is token-bound]"];
  }
  const newLines = content.replace(/\n$/u, "").split("\n");
  return [
    `--- ${mode === "create" ? "/dev/null" : path}`,
    `+++ ${path}`,
    `@@ -1,${Math.max(1, oldLines.length)} +1,${Math.max(1, newLines.length)} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function compactPreview(preview: Omit<DoctorApplyPreview, "rendered">): Omit<DoctorApplyPreview, "rendered"> {
  const copy = { ...preview, operations: preview.operations.map((operation) => ({ ...operation, content: bounded(operation.content, 16 * 1024), proposedDiff: bounded(operation.proposedDiff, 16 * 1024) })) };
  return copy;
}

function renderedPreview(preview: Omit<DoctorApplyPreview, "rendered">): string {
  const candidate = JSON.stringify(preview, null, 2);
  if (Buffer.byteLength(candidate, "utf8") <= DOCTOR_APPLY_MAX_SERIALIZED_BYTES) return candidate;
  const compact = { ...compactPreview(preview), proposedDiff: bounded(preview.proposedDiff, 8 * 1024), legacyHints: preview.legacyHints.slice(0, 8) };
  const compactText = JSON.stringify(compact, null, 2);
  if (Buffer.byteLength(compactText, "utf8") <= DOCTOR_APPLY_MAX_SERIALIZED_BYTES) return compactText;
  // Keep the token, root binding, named operations, and conflict evidence even
  // when hostile report strings fill the first compact representation. Every
  // string remains valid JSON; no substring of serialized JSON is returned.
  const minimal = {
    ...preview,
    operations: preview.operations.map((operation) => ({
      ...operation,
      content: bounded(operation.content, 1024),
      proposedDiff: bounded(operation.proposedDiff, 1024),
    })),
    conflicts: preview.conflicts.slice(0, DOCTOR_APPLY_PATHS.length + 1),
    legacyHints: preview.legacyHints.slice(0, DOCTOR_APPLY_MAX_HINTS),
    proposedDiff: bounded(preview.proposedDiff, 2048),
  };
  const minimalText = JSON.stringify(minimal, null, 2);
  if (Buffer.byteLength(minimalText, "utf8") <= DOCTOR_APPLY_MAX_SERIALIZED_BYTES) return minimalText;
  return JSON.stringify({
    schema: preview.schema, schemaVersion: preview.schemaVersion, root: preview.root, mode: preview.mode,
    token: preview.token, expiresAt: preview.expiresAt, digest: preview.digest,
    operations: preview.operations.map((operation) => ({ path: operation.path, absolutePath: operation.absolutePath, mode: operation.mode, contentHash: operation.contentHash })),
    conflicts: preview.conflicts.map((conflict) => ({ path: conflict.path, reason: bounded(conflict.reason, 256) })),
    proposedDiff: bounded(preview.proposedDiff, 512), readOnly: true, applyAvailable: true,
  }, null, 2);
}

export class DoctorApplyManager {
  private readonly fileSystem: DoctorApplyFileSystem;
  private readonly clock: () => number;
  private readonly previews = new Map<string, PreviewEntry>();
  private readonly recoveries = new Map<string, RecoveryEntry>();
  private backupBytes = 0;
  private locked = false;

  constructor(options: { now?: () => number; clock?: () => number; fs?: ApplyFsOverrides; fileSystem?: ApplyFsOverrides; filesystem?: ApplyFsOverrides } = {}) {
    this.clock = options.now ?? options.clock ?? (() => Date.now());
    this.fileSystem = makeFileSystem(options.fs ?? options.fileSystem ?? options.filesystem ?? {});
    // Detect bounded stale candidates without mutating the host temp area;
    // crash leftovers remain host-managed. Live map/backup cleanup above is
    // authoritative for explicitly held references in this instance.
    scavengeDoctorRecoveryDirectories();
  }

  cleanup(): void {
    this.cleanupAt(this.clock());
  }

  private cleanupAt(now: number): void {
    for (const [token, entry] of this.previews) if (entry.preview.expiresAt <= now) this.previews.delete(token);
    for (const [token, entry] of this.recoveries) {
      if (entry.expiresAt <= now) {
        this.removeBackup(entry);
        this.recoveries.delete(token);
      }
    }
  }

  clear(): void {
    for (const entry of this.recoveries.values()) this.removeBackup(entry);
    this.previews.clear();
    this.recoveries.clear();
    this.backupBytes = 0;
  }

  createDoctorApplyPreview(root: string, report: DoctorReport, options: DoctorApplyOptions = {}): DoctorApplyPreview {
    this.cleanup();
    // Preview is deliberately read-only. Direct API callers may inspect an
    // untrusted or busy project, while the registered command applies its own
    // conservative trust gate before reaching this method.
    if (this.previews.size >= DOCTOR_APPLY_MAX_PREVIEWS) throw new DoctorApplyError("bounds", "Too many unexpired doctor apply previews.");
    const rootInfo = rootSnapshot(root, this.fileSystem);
    const selectedPath = options.replacePath ?? options.replacementPath ?? options.path ?? options.replace ?? options.replacement;
    if (selectedPath !== undefined && !(DOCTOR_APPLY_PATHS as readonly string[]).includes(selectedPath)) throw new DoctorApplyError("path", "Replacement is limited to an exact documented target path.");
    const hints = collectLegacyHints(rootInfo.path, this.fileSystem);
    const contents = generateContents(report, hints);
    const names: Array<(typeof DOCTOR_APPLY_PATHS)[number]> = selectedPath
      ? [selectedPath as (typeof DOCTOR_APPLY_PATHS)[number]]
      : [...DOCTOR_APPLY_PATHS];
    const operations: DoctorApplyOperation[] = [];
    const conflicts: DoctorApplyConflict[] = [];
    for (const path of names) {
      const absolute = targetPath(rootInfo.path, path);
      const parent = dirname(absolute);
      assertParentNoFollow(absolute, this.fileSystem);
      const parentSnapshot = lstatSnapshot(parent, this.fileSystem);
      if (parentSnapshot.exists && !this.isDirectory(parent)) throw new DoctorApplyError("unsafe-parent", `Refusing non-directory parent: ${path}`);
      const target = lstatSnapshot(absolute, this.fileSystem);
      const mode: DoctorApplyMode = selectedPath ? "replace" : "create";
      if (mode === "replace" && !target.exists) {
        conflicts.push({ path, reason: "replacement requires an existing regular target", target });
        continue;
      }
      if (mode === "create" && target.exists) {
        conflicts.push({ path, reason: "target already exists; request an exact replacement preview", target });
        continue;
      }
      const content = path === DOCTOR_APPLY_PROFILE_PATH ? contents.profile : contents.guidance;
      let existing: Buffer | undefined;
      if (target.exists) existing = readRegular(absolute, target, this.fileSystem).data;
      operations.push({
        path, absolutePath: absolute, mode, content, contentHash: hash(content), parent: parentSnapshot, target: target.exists ? { ...target, hash: hash(existing ?? Buffer.alloc(0)) } : target,
        proposedDiff: unifiedDiff(path, content, existing, mode),
      });
    }
    const digest = hash(JSON.stringify({
      root: rootInfo, mode: selectedPath ? "replace" : "create", operations: operations.map((item) => ({ path: item.path, mode: item.mode, contentHash: item.contentHash, parent: item.parent, target: item.target })),
      conflicts: conflicts.map((item) => ({ path: item.path, target: item.target })), hints: hints.map((hint) => ({ source: hint.source, hash: hint.hash })),
    }));
    const token = randomBytes(DOCTOR_APPLY_TOKEN_BYTES).toString("hex");
    const expiresAt = (options.now ?? this.clock)() + DOCTOR_APPLY_TOKEN_TTL_MS;
    const base: Omit<DoctorApplyPreview, "rendered"> = {
      schema: "godmode-doctor-apply", schemaVersion: 1, root: rootInfo, mode: selectedPath ? "replace" : "create", token, expiresAt, digest,
      operations, conflicts, legacyHints: hints, proposedDiff: operations.map((item) => item.proposedDiff).join("\n"), readOnly: true, applyAvailable: true,
    };
    const preview = { ...base, rendered: renderedPreview(base) };
    if (Buffer.byteLength(JSON.stringify(preview), "utf8") > DOCTOR_APPLY_MAX_SERIALIZED_BYTES) throw new DoctorApplyError("bounds", "The doctor apply preview exceeds its serialization bound.");
    // Keep an internal snapshot separate from the returned object. A caller
    // must not be able to alter an operation after seeing its token/digest.
    const storedOperations = operations.map((operation) => ({ ...operation, parent: { ...operation.parent }, target: { ...operation.target } }));
    const storedPreview: DoctorApplyPreview = {
      ...preview,
      operations: storedOperations,
      conflicts: preview.conflicts.map((conflict) => ({ ...conflict, target: { ...conflict.target } })),
      legacyHints: preview.legacyHints.map((hint) => ({ ...hint })),
    };
    this.previews.set(token, { preview: storedPreview, root: { ...rootInfo }, createdAt: (options.now ?? this.clock)(), operations: storedOperations, hintHashes: hints.map((hint) => `${hint.source}\0${hint.hash}`).sort() });
    return preview;
  }

  /** Short method names are useful to embedders while the verbose names are
   * retained as the public contract used by the command adapter. */
  createPreview(root: string, report: DoctorReport, options: DoctorApplyOptions = {}): DoctorApplyPreview {
    return this.createDoctorApplyPreview(root, report, options);
  }

  applyDoctorPreview(root: string, token: string, options: DoctorApplyOptions = {}): DoctorApplyResult {
    return this.withLock(() => {
      this.cleanupAt((options.now ?? this.clock)());
      try {
        this.assertEffectfulAllowed(options);
        const entry = this.takePreview(root, token, (options.now ?? this.clock)());
        const currentRoot = rootSnapshot(root, this.fileSystem);
        if (!sameRoot(entry.root, currentRoot)) return this.result("conflict", [], [{ path: "<root>", reason: "project root identity changed" }], ["Confirmation token is bound to a different project root."]);
        const currentHintHashes = collectLegacyHints(currentRoot.path, this.fileSystem).map((hint) => `${hint.source}\0${hint.hash}`).sort();
        if (currentHintHashes.length !== entry.hintHashes.length || currentHintHashes.some((value, index) => value !== entry.hintHashes[index])) return this.result("conflict", [], [{ path: "<legacy-hints>", reason: "legacy hint sources changed after preview" }], ["No files were written; legacy candidate hints changed after preview."]);
        if (entry.preview.conflicts.length > 0) return this.result("conflict", [], entry.preview.conflicts.map((item) => ({ path: item.path, reason: item.reason })), ["No files were written; the preview contained conflicts."]);
        const preflight = this.checkOperations(entry.operations);
        if (preflight.length > 0) return this.result("conflict", [], preflight, ["No files were written; a target or parent changed after preview."]);
        const applied: string[] = [];
        const failed: Array<{ path: string; reason: string }> = [];
        const warnings: string[] = [];
        let conflictFailure = false;
        const statuses: Array<{ path: string; status: "applied" | "failed"; reason?: string }> = [];
        const recoveryEntries: RecoveryEntry[] = [];
        let stoppedAt = -1;
        for (let index = 0; index < entry.operations.length; index += 1) {
          const operation = entry.operations[index];
          if (!operation) continue;
          try {
            options.beforeWrite?.(operation, index);
            const changed = this.checkOperations([operation]);
            if (changed.length > 0) throw new DoctorApplyError("conflict", changed[0]?.reason ?? "operation changed");
            const recovery = operation.mode === "replace" ? this.replace(operation, currentRoot, (options.now ?? this.clock)()) : undefined;
            if (operation.mode === "create") this.create(operation, currentRoot);
            applied.push(operation.path);
            statuses.push({ path: operation.path, status: "applied" });
            if (recovery) recoveryEntries.push(recovery);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const proven = error instanceof PostCommitRestorationError
              ? { path: error.appliedPath, target: error.appliedTarget }
              : error instanceof ReplacementFailure && error.appliedPath && error.appliedTarget
                ? { path: error.appliedPath, target: error.appliedTarget } : undefined;
            if (proven && proven.path === operation.path && proven.target.exists && proven.target.hash === operation.contentHash) {
              // The write and its exact bytes were proven before cwd restore
              // failed. It is applied, not a failed operation; the warning and
              // the explicit not-attempted statuses preserve the partial state.
              applied.push(operation.path);
              warnings.push(`Target ${operation.path} was installed and verified, but cwd (working directory) restoration failed: ${reason}`);
              statuses.push({ path: operation.path, status: "applied" });
            } else {
              failed.push({ path: operation.path, reason });
              const systemCode = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
              if ((error instanceof DoctorApplyError && error.code === "conflict") || systemCode === "EEXIST" || systemCode === "ENOENT" || systemCode === "ELOOP") conflictFailure = true;
              statuses.push({ path: operation.path, status: "failed", reason });
            }
            if (error instanceof ReplacementFailure && error.recovery) recoveryEntries.push(error.recovery);
            stoppedAt = index;
            break;
          }
        }
        // A multi-target create is intentionally not an all-or-nothing
        // transaction. Make every not-attempted operation explicit instead of
        // hiding the remainder after the first filesystem failure.
        if (stoppedAt >= 0) {
          for (let index = stoppedAt + 1; index < entry.operations.length; index += 1) {
            const operation = entry.operations[index];
            if (!operation) continue;
            const reason = "not attempted after a prior operation failed";
            failed.push({ path: operation.path, reason });
            statuses.push({ path: operation.path, status: "failed", reason });
          }
        }
        for (const recovery of recoveryEntries) this.storeRecovery(recovery);
        const status = warnings.length > 0 ? (applied.length > 0 ? "partial" : "error")
          : failed.length > 0 ? (applied.length > 0 ? "partial" : conflictFailure ? "conflict" : "error") : "applied";
        const recoveryToken = recoveryEntries[0]?.token;
        return this.result(status, applied, failed, warnings, statuses, recoveryToken);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const denied = error instanceof DoctorApplyError && ["trust", "active", "idle", "token"].includes(error.code);
        const conflict = error instanceof DoctorApplyError && error.code === "root";
        return this.result(conflict ? "conflict" : denied ? "denied" : "error", [], [{ path: "<apply>", reason }], [reason]);
      }
    });
  }

  apply(root: string, token: string, options: DoctorApplyOptions = {}): DoctorApplyResult {
    return this.applyDoctorPreview(root, token, options);
  }

  recoverDoctorPreview(root: string, token: string, options: DoctorApplyOptions = {}): DoctorApplyRecoveryResult {
    return this.withLock(() => {
      this.cleanupAt((options.now ?? this.clock)());
      let entry: RecoveryEntry | undefined;
      try {
        this.assertEffectfulAllowed(options);
        if (!SAFE_TOKEN.test(token)) throw new DoctorApplyError("token", "Recovery token is malformed.");
        entry = this.recoveries.get(token);
        if (!entry) throw new DoctorApplyError("token", "Recovery token is unknown, expired, or already used.");
        const currentRoot = rootSnapshot(root, this.fileSystem);
        // Root validation happens before any token/backup mutation. A wrong
        // root therefore cannot burn a still-valid recovery handle.
        if (!sameRoot(entry.root, currentRoot)) throw new DoctorApplyError("root", "Recovery token is bound to another project root.");
        const parentPath = dirname(entry.operation.absolutePath);
        const targetName = basename(entry.operation.absolutePath);
        const parent = lstatSnapshot(parentPath, this.fileSystem);
        if (!sameParent(parent, entry.parent)) throw new DoctorApplyError("conflict", "Recovery refused because the target parent changed.");
        // The generated-target check is deliberately deferred to the pinned
        // recovery section below; an absolute pre-check could race a swapped
        // parent and is not authoritative for the rename.
        const data = this.readBackup(entry);
        this.withPinnedParent(parentPath, entry.parent, () => {
          const temp = this.writeTempFile(parentPath, data, true);
          try {
            // Final checks and the recovery rename are basename-relative while
            // cwd is pinned. The absolute parent check only detects a lexical
            // swap; it is never used as the mutation path.
            assertParentNoFollow(entry!.operation.absolutePath, this.fileSystem);
            this.assertPinnedParent(entry!.parent);
            const unchanged = this.recoveryTargetSnapshot(targetName, entry!.generated);
            // A rename may have completed before a later sync/verification or
            // cwd restoration failure. If the target already has the verified
            // backup bytes, a retry can prove/finalize that same restoration
            // without requiring the now-absent generated target.
            if (unchanged.hash === entry!.backupHash) {
              this.syncFile(targetName);
            } else {
              if (!sameRecoveryTarget(unchanged, entry!.generated)) throw new DoctorApplyError("conflict", "Recovery target changed before restore.");
              this.fileSystem.renameSync(temp.file, targetName);
              this.syncFile(targetName);
            }
            const restoredState = lstatSnapshot(targetName, this.fileSystem);
            if (!restoredState.exists) throw new DoctorApplyError("verify", "Restored target is missing.");
            const restored = readRegular(targetName, restoredState, this.fileSystem).snapshot;
            if (!restored.hash || restored.hash !== entry!.backupHash) throw new DoctorApplyError("verify", "Restored target hash did not verify.");
            assertParentNoFollow(entry!.operation.absolutePath, this.fileSystem);
          } finally {
            // The temp file is also addressed relative to the pinned parent;
            // a swapped lexical parent cannot turn cleanup into an outside
            // unlink.
            this.removeTemp(temp);
          }
        }, entry.restoreCwd);
        // Only after target bytes and cwd restoration have both been proven is
        // the handle consumed and its verified backup eligible for cleanup.
        this.recoveries.delete(token);
        this.removeBackup(entry);
        return this.recoveryResult("recovered", entry.operation.path);
      } catch (error) {
        // Every unproven failure retains the same map entry and backup. A cwd
        // failure also records the known original cwd so the next retry can
        // restore process state rather than accepting the pinned parent as a
        // new baseline.
        if (entry && error instanceof CwdRestorationError) entry.restoreCwd = error.restoreCwd;
        const reason = error instanceof Error ? error.message : String(error);
        const denied = error instanceof DoctorApplyError && ["trust", "active", "idle"].includes(error.code);
        return this.recoveryResult(denied ? "denied" : "refused", undefined, reason, entry ? token : undefined);
      }
    });
  }

  recover(root: string, token: string, options: DoctorApplyOptions = {}): DoctorApplyRecoveryResult {
    return this.recoverDoctorPreview(root, token, options);
  }

  private assertEffectfulAllowed(options: DoctorApplyOptions): void {
    if (options.trusted !== true) throw new DoctorApplyError("trust", "Applying doctor output requires affirmative project trust.");
    if (!Object.hasOwn(options, "activeFaculty") || options.activeFaculty !== null) {
      throw new DoctorApplyError("active", "Applying doctor output requires explicit proof that no faculty is active (activeFaculty: null).");
    }
    if (options.isIdle !== true && options.idle !== true) throw new DoctorApplyError("idle", "Applying doctor output requires affirmative idle proof.");
  }

  private isDirectory(path: string): boolean {
    try {
      const stat = this.fileSystem.lstatSync(path);
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch { return false; }
  }

  /**
   * Pin a target parent by changing cwd to that directory inode. Every path
   * used by the callback must therefore be a basename (or a path outside the
   * project, such as a recovery backup). A lexical parent swap after the
   * pre-check cannot redirect a relative syscall made from this cwd.
   *
   * chdir is process-global, so this is intentionally synchronous and only
   * called while withLock holds the synchronous process-global cwd guard.
   * Restoration is verified by both the original spelling and the original cwd
   * identity; a failed proof
   * is surfaced instead of allowing another operation to run.
   */
  private withPinnedParent<T>(
    parentPath: string,
    expectedParent: DoctorApplyTargetSnapshot,
    action: () => T,
    restoreCwd?: CwdBinding,
  ): T {
    let originalCwd: string;
    let originalCwdIdentity: DoctorApplyTargetSnapshot;
    try {
      // A recovery retry may be continuing after a prior restoration failure.
      // In that case the failed attempt already recorded the cwd that must be
      // restored, even though the process may still be pinned in the parent.
      originalCwd = restoreCwd?.path ?? this.fileSystem.cwd();
      originalCwdIdentity = restoreCwd?.identity ?? lstatSnapshot(".", this.fileSystem);
    } catch (error) {
      throw new DoctorApplyError("cwd", `Could not establish the original working directory: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Set this before chdir: a hostile seam can report failure after changing
    // cwd, and the finally block must still attempt restoration in that case.
    let restoreRequired = true;
    let actionResult: T | undefined;
    let actionFailure: unknown;
    let restorationFailure: CwdRestorationError | undefined;
    try {
      assertParentNoFollow(parentPath, this.fileSystem);
      this.fileSystem.chdir(parentPath);
      this.assertPinnedParent(expectedParent);
      // This catches a lexical swap which happened between the no-follow
      // check and chdir. The mutation itself still uses the pinned `.`.
      assertParentNoFollow(parentPath, this.fileSystem);
      actionResult = action();
    } catch (error) {
      actionFailure = error;
    } finally {
      if (restoreRequired) {
        try {
          this.fileSystem.chdir(originalCwd);
          const restoredPath = this.fileSystem.cwd();
          const restoredIdentity = lstatSnapshot(".", this.fileSystem);
          if (restoredPath !== originalCwd || !sameParent(restoredIdentity, originalCwdIdentity)) {
            throw new Error("working directory identity could not be proven after restoration");
          }
        } catch (error) {
          restorationFailure = new CwdRestorationError(
            `Working directory restoration could not be proven: ${error instanceof Error ? error.message : String(error)}`,
            { path: originalCwd, identity: originalCwdIdentity },
          );
        }
      }
    }
    if (restorationFailure !== undefined) {
      if (isPinnedCommitProof(actionResult)) throw new PostCommitRestorationError(restorationFailure.message, restorationFailure.restoreCwd, actionResult);
      throw restorationFailure;
    }
    if (actionFailure !== undefined) throw actionFailure;
    return actionResult as T;
  }

  private assertPinnedParent(expected: DoctorApplyTargetSnapshot): void {
    let stat: fs.Stats;
    try { stat = this.fileSystem.lstatSync("."); }
    catch (error) { throw new DoctorApplyError("conflict", `Pinned target parent could not be inspected: ${error instanceof Error ? error.message : String(error)}`); }
    if (stat.isSymbolicLink() || !stat.isDirectory()
      || !expected.exists || expected.dev === undefined || expected.ino === undefined
      || Number(stat.dev) !== expected.dev || Number(stat.ino) !== expected.ino) {
      throw new DoctorApplyError("conflict", "Target parent identity changed before the filesystem mutation.");
    }
  }

  private takePreview(root: string, token: string, at = this.clock()): PreviewEntry {
    if (!SAFE_TOKEN.test(token)) throw new DoctorApplyError("token", "Confirmation token is malformed.");
    const entry = this.previews.get(token);
    if (!entry || entry.preview.expiresAt <= at) {
      if (entry) this.previews.delete(token);
      throw new DoctorApplyError("token", "Confirmation token is unknown, expired, or already used.");
    }
    // A valid token is consumed on its first confirmation attempt. A wrong
    // root is rejected before this deletion so another project cannot burn it.
    const current = rootSnapshot(root, this.fileSystem);
    if (!sameRoot(entry.root, current)) throw new DoctorApplyError("root", "Confirmation token is bound to another project root.");
    this.previews.delete(token);
    return entry;
  }

  private checkOperations(operations: readonly DoctorApplyOperation[]): Array<{ path: string; reason: string }> {
    const issues: Array<{ path: string; reason: string }> = [];
    for (const operation of operations) {
      try {
        assertParentNoFollow(operation.absolutePath, this.fileSystem);
        const parent = lstatSnapshot(dirname(operation.absolutePath), this.fileSystem);
        if (!sameIdentity(parent, operation.parent)) issues.push({ path: operation.path, reason: "target parent snapshot changed" });
        const target = lstatSnapshot(operation.absolutePath, this.fileSystem);
        if (operation.mode === "create" && target.exists) issues.push({ path: operation.path, reason: "target now exists; refusing overwrite" });
        if (operation.mode === "replace" && (!target.exists || target.dev !== operation.target.dev || target.ino !== operation.target.ino || target.size !== operation.target.size || target.mtimeMs !== operation.target.mtimeMs)) issues.push({ path: operation.path, reason: "replacement target changed" });
        if (operation.mode === "replace") {
          const actual = snapshotWithHash(operation.absolutePath, operation.target, this.fileSystem);
          if (!sameIdentity(actual, operation.target)) issues.push({ path: operation.path, reason: "replacement target content changed" });
        }
      } catch (error) { issues.push({ path: operation.path, reason: error instanceof Error ? error.message : String(error) }); }
    }
    return issues;
  }

  private create(operation: DoctorApplyOperation, root: RootSnapshot): void {
    const parentPath = dirname(operation.absolutePath);
    const targetName = basename(operation.absolutePath);
    assertParentNoFollow(operation.absolutePath, this.fileSystem);
    let parent = lstatSnapshot(parentPath, this.fileSystem);
    let createdParent = false;
    if (!parent.exists) {
      if (operation.parent.exists) throw new DoctorApplyError("conflict", "Target parent changed before creation.");
      try {
        // The exact parent is created first, then its resulting inode is bound
        // for the pinned operation below. mkdir is exclusive and therefore a
        // racer-created directory or symlink is a conflict, never authority.
        this.fileSystem.mkdirSync(parentPath, { recursive: false, mode: 0o700 });
        createdParent = true;
        parent = lstatSnapshot(parentPath, this.fileSystem);
        if (!parent.exists) throw new DoctorApplyError("conflict", "Created target parent could not be bound.");
      } catch (error) {
        if (createdParent && parent.exists && error instanceof DoctorApplyError && error.code === "cwd") throw error;
        if (createdParent && parent.exists) this.removeCreatedParent(root, parentPath, parent);
        throw error;
      }
    }
    if (!parent.exists || (operation.parent.exists ? !sameIdentity(parent, operation.parent) : !createdParent)) {
      throw new DoctorApplyError("conflict", "Target parent changed before creation.");
    }
    const expectedParent = operation.parent.exists ? operation.parent : parent;

    let linked = false;
    let linkedTarget: DoctorApplyTargetSnapshot | undefined;
    try {
      this.withPinnedParent(parentPath, expectedParent, () => {
        let temp: { directory: string; file: string } | undefined;
        try {
          // Final target checks and the exclusive hard link are basename
          // relative. The cwd is pinned to the preview-bound parent inode.
          assertParentNoFollow(operation.absolutePath, this.fileSystem);
          this.assertPinnedParent(expectedParent);
          const target = lstatSnapshot(targetName, this.fileSystem);
          if (target.exists) throw new DoctorApplyError("conflict", "Target now exists; refusing overwrite.");
          temp = this.writeTempFile(parentPath, Buffer.from(operation.content, "utf8"), true);
          this.fileSystem.linkSync(temp.file, targetName);
          linked = true;
          linkedTarget = lstatSnapshot(targetName, this.fileSystem);
          const verified = this.verifyFile(targetName, operation.contentHash);
          // Detect an injected lexical parent swap after the syscall. This
          // check is advisory only; the syscall above was already pinned.
          assertParentNoFollow(operation.absolutePath, this.fileSystem);
          return { kind: "doctor-apply-commit-proof" as const, path: operation.path, target: verified } satisfies PinnedCommitProof;
        } catch (error) {
          // If link completed but verification failed, remove only the exact
          // target in the pinned parent. An ambiguous link throw is retained.
          if (linked && linkedTarget?.exists) {
            try {
              const currentState = lstatSnapshot(targetName, this.fileSystem);
              const current = snapshotWithHash(targetName, currentState, this.fileSystem);
              if (sameCommitTarget(current, linkedTarget) && current.hash === operation.contentHash) {
                this.fileSystem.unlinkSync(targetName);
                if (lstatSnapshot(targetName, this.fileSystem).exists) throw new Error("created target cleanup was not proven");
              }
            } catch { /* retain the target if cleanup cannot be proven */ }
          }
          throw error;
        } finally {
          if (temp) this.removeTemp(temp);
        }
      });
    } catch (error) {
      // Never follow a swapped absolute parent during cleanup. This helper
      // pins the stable project root and removes only the basename if the
      // created parent is still the exact inode created above.
      if (createdParent && !(error instanceof DoctorApplyError && error.code === "cwd")) {
        this.removeCreatedParent(root, parentPath, parent);
      }
      throw error;
    }
  }

  private removeCreatedParent(root: RootSnapshot, parentPath: string, expected: DoctorApplyTargetSnapshot): void {
    try {
      const rootParent: DoctorApplyTargetSnapshot = { exists: true, dev: root.dev, ino: root.ino };
      this.withPinnedParent(root.path, rootParent, () => {
        const parentName = basename(parentPath);
        const current = lstatSnapshot(parentName, this.fileSystem);
        if (!sameParent(current, expected)) return;
        // basename-relative to the pinned root; a lexical parent symlink is
        // observed as a symlink and is never removed.
        this.fileSystem.rmdirSync(parentName);
      });
    } catch (error) {
      // Races, non-empty directories, and an already-removed parent are safe
      // to retain. A cwd restoration failure is not safe to hide.
      if (error instanceof DoctorApplyError && error.code === "cwd") throw error;
    }
  }

  private replace(operation: DoctorApplyOperation, root: RootSnapshot, appliedAt = this.clock()): RecoveryEntry {
    const parentPath = dirname(operation.absolutePath);
    const targetName = basename(operation.absolutePath);
    // Read the replacement source through the pinned parent too. The backup
    // must not be sourced from an external directory if the lexical parent
    // races between its preview check and this read.
    const existing = this.withPinnedParent(parentPath, operation.parent, () => {
      assertParentNoFollow(operation.absolutePath, this.fileSystem);
      this.assertPinnedParent(operation.parent);
      const value = readRegular(targetName, operation.target, this.fileSystem);
      assertParentNoFollow(operation.absolutePath, this.fileSystem);
      return value;
    });
    if (!sameIdentity(existing.snapshot, operation.target)) throw new DoctorApplyError("conflict", "Replacement target changed before backup.");
    if (this.recoveries.size >= DOCTOR_APPLY_MAX_RECOVERIES || this.backupBytes + existing.data.byteLength > DOCTOR_APPLY_MAX_BACKUP_BYTES) throw new DoctorApplyError("bounds", "Recovery backup capacity is exhausted.");
    const backupDirectory = this.fileSystem.mkdtempSync(join(tmpdir(), "godmode-doctor-recovery-"));
    try { this.fileSystem.chmodSync(backupDirectory, 0o700); } catch { /* mkdtemp is owner-only on supported hosts */ }
    const backupPath = join(backupDirectory, basename(operation.absolutePath));
    const backupHash = hash(existing.data);
    let committed = false;
    let committedTarget: DoctorApplyTargetSnapshot | undefined;
    let rollbackCompleted = false;
    try {
      this.writeExclusive(backupPath, existing.data);
      // Verify the bytes from the actual backup path, not merely the input
      // buffer returned by writeExclusive. The backup is the last recovery
      // authority and must remain bounded and independently readable.
      const backupState = lstatSnapshot(backupPath, this.fileSystem);
      if (!backupState.exists || backupState.size === undefined || backupState.size > DOCTOR_APPLY_MAX_BACKUP_BYTES) throw new DoctorApplyError("verify", "Recovery backup exceeds its bounded size.");
      const verifiedBackup = readRegular(backupPath, backupState, this.fileSystem).data;
      if (hash(verifiedBackup) !== backupHash) throw new DoctorApplyError("verify", "Recovery backup hash did not verify.");

      let generated: DoctorApplyTargetSnapshot | undefined;
      this.withPinnedParent(parentPath, operation.parent, () => {
        const temp = this.writeTempFile(parentPath, Buffer.from(operation.content, "utf8"), true);
        try {
          // The final target check, atomic commit, and post-write verification
          // all use the basename from the preview-bound pinned parent.
          assertParentNoFollow(operation.absolutePath, this.fileSystem);
          this.assertPinnedParent(operation.parent);
          const unchanged = snapshotWithHash(targetName, operation.target, this.fileSystem);
          if (!sameIdentity(unchanged, operation.target)) throw new DoctorApplyError("conflict", "Replacement target changed before atomic replacement.");
          // Mark the commit as indeterminate before invoking rename. A hostile
          // or injected filesystem seam may replace the target and then throw;
          // treating that case as committed ensures the backup is restored rather
          // than silently discarded.
          committed = true;
          this.fileSystem.renameSync(temp.file, targetName);
          // Capture identity as soon as the atomic rename commits. If a later
          // injected fsync/read verification fails, this binding lets rollback
          // distinguish the committed target from a concurrent replacement.
          try {
            // lstat is sufficient for the commit binding. Content verification
            // follows separately and may itself be the injected failure; using a
            // potentially failed read here would make a good rollback look raced.
            committedTarget = lstatSnapshot(targetName, this.fileSystem);
          } catch { /* rollback below still retains a bounded recovery handle */ }
          this.syncFile(targetName);
          const verified = this.verifyFile(targetName, operation.contentHash);
          // Detect a lexical swap injected after rename. The committed syscall
          // was pinned, so this check cannot redirect or mutate the external
          // target; it instead requires rollback/recovery handling. When the
          // old parent is still pinned, restore it before cwd is returned so a
          // parent swap has no net project-target change.
          try {
            assertParentNoFollow(operation.absolutePath, this.fileSystem);
          } catch (error) {
            try {
              this.rollbackReplacementPinned(operation, backupPath, backupHash, committedTarget);
              rollbackCompleted = true;
            } catch { /* outer rollback/recovery path retains the verified backup */ }
            throw error;
          }

          // The verified snapshot is the commit proof. Keep it inside the
          // pinned region so a later cwd restoration failure can report the
          // exact target as applied without another fallible read.
          generated = verified;
          committedTarget = generated;
          return { kind: "doctor-apply-commit-proof" as const, path: operation.path, target: generated } satisfies PinnedCommitProof;
        } finally {
          this.removeTemp(temp);
        }
      });
      if (!generated) throw new DoctorApplyError("verify", "Replacement result could not be bound after commit.");
      const token = randomBytes(DOCTOR_APPLY_TOKEN_BYTES).toString("hex");
      return { token, root, operation, backupPath, backupDirectory, backupHash, generated, parent: operation.parent, expiresAt: appliedAt + DOCTOR_APPLY_TOKEN_TTL_MS };
    } catch (error) {
      if (!committed) {
        this.removeBackupPath(backupPath, backupDirectory);
        throw error;
      }

      // If cwd restoration was not proven, do not attempt another mutation.
      // Retain the verified backup as a bounded recovery handle instead.
      if (error instanceof DoctorApplyError && error.code === "cwd") {
        const restoreCwd = error instanceof CwdRestorationError ? error.restoreCwd : undefined;
        const recovery = this.recoveryForFailedReplacement(
          operation, root, backupPath, backupDirectory, backupHash, committedTarget, appliedAt, false, restoreCwd,
        );
        const proof = error instanceof PostCommitRestorationError
          ? { kind: "doctor-apply-commit-proof" as const, path: error.appliedPath, target: error.appliedTarget } satisfies PinnedCommitProof
          : undefined;
        throw new ReplacementFailure("partial", error.message, recovery, proof);
      }

      // The target was atomically replaced. First attempt an immediate atomic
      // restore from the verified backup. Never delete that backup before the
      // restored bytes and identity have been proven. A lexical parent swap
      // may already have completed this rollback while the parent was pinned.
      if (rollbackCompleted) {
        this.removeBackupPath(backupPath, backupDirectory);
        throw error;
      }
      let rollbackError: unknown;
      try {
        this.rollbackReplacement(operation, backupPath, backupHash, committedTarget);
      } catch (failure) {
        rollbackError = failure;
      }
      if (rollbackError === undefined) {
        this.removeBackupPath(backupPath, backupDirectory);
        throw error;
      }
      const recovery = this.recoveryForFailedReplacement(
        operation, root, backupPath, backupDirectory, backupHash, committedTarget, appliedAt,
        !(rollbackError instanceof DoctorApplyError && rollbackError.code === "cwd"),
        rollbackError instanceof CwdRestorationError ? rollbackError.restoreCwd : undefined,
      );
      throw new ReplacementFailure(
        "partial",
        `Replacement verification failed and automatic rollback could not be proven: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        recovery,
      );
    }
  }

  private rollbackReplacement(
    operation: DoctorApplyOperation,
    backupPath: string,
    backupHash: string,
    committedTarget: DoctorApplyTargetSnapshot | undefined,
  ): void {
    const parentPath = dirname(operation.absolutePath);
    this.withPinnedParent(parentPath, operation.parent, () => {
      this.rollbackReplacementPinned(operation, backupPath, backupHash, committedTarget);
    });
  }

  /** Roll back while the caller still owns a pinned parent cwd. */
  private rollbackReplacementPinned(
    operation: DoctorApplyOperation,
    backupPath: string,
    backupHash: string,
    committedTarget: DoctorApplyTargetSnapshot | undefined,
  ): void {
    const parentPath = dirname(operation.absolutePath);
    const targetName = basename(operation.absolutePath);
    const backupState = lstatSnapshot(backupPath, this.fileSystem);
    if (!backupState.exists || backupState.size === undefined || backupState.size > DOCTOR_APPLY_MAX_BACKUP_BYTES) throw new DoctorApplyError("recovery", "Verified recovery backup is unavailable.");
    const backup = readRegular(backupPath, backupState, this.fileSystem).data;
    if (hash(backup) !== backupHash) throw new DoctorApplyError("recovery", "Verified recovery backup hash changed.");
    this.assertPinnedParent(operation.parent);
    const currentState = lstatSnapshot(targetName, this.fileSystem);
    if (!currentState.exists) throw new DoctorApplyError("conflict", "Replacement target changed before automatic rollback.");
    const current = snapshotWithHash(targetName, currentState, this.fileSystem);
    if (committedTarget && !sameCommitTarget(current, committedTarget)) throw new DoctorApplyError("conflict", "Replacement target changed before automatic rollback.");
    const temp = this.writeTempFile(parentPath, backup, true);
    try {
      // Final rollback checks and the restore rename remain relative to the
      // pinned directory, including cleanup if a rename seam races the path.
      this.assertPinnedParent(operation.parent);
      const unchangedState = lstatSnapshot(targetName, this.fileSystem);
      const unchanged = unchangedState.exists ? snapshotWithHash(targetName, unchangedState, this.fileSystem) : unchangedState;
      if (!sameCommitTarget(unchanged, current)) throw new DoctorApplyError("conflict", "Replacement target changed during automatic rollback.");
      this.fileSystem.renameSync(temp.file, targetName);
      this.syncFile(targetName);
      const restoredState = lstatSnapshot(targetName, this.fileSystem);
      const restored = snapshotWithHash(targetName, restoredState, this.fileSystem);
      if (!restored.hash || restored.hash !== backupHash) throw new DoctorApplyError("verify", "Automatic rollback hash did not verify.");
    } finally {
      this.removeTemp(temp);
    }
  }

  private recoveryForFailedReplacement(
    operation: DoctorApplyOperation,
    root: RootSnapshot,
    backupPath: string,
    backupDirectory: string,
    backupHash: string,
    committedTarget: DoctorApplyTargetSnapshot | undefined,
    appliedAt: number,
    inspectTarget = true,
    restoreCwd?: CwdBinding,
  ): RecoveryEntry {
    let generated: DoctorApplyTargetSnapshot | undefined;
    let observedState: DoctorApplyTargetSnapshot | undefined;
    let retainedRestoreCwd = restoreCwd;
    if (inspectTarget) {
      try {
        // Recovery metadata is gathered through the same pinned-parent seam as
        // the commit/rollback paths. If the lexical parent was swapped,
        // pinning refuses it and the already captured commit identity is
        // retained.
        const parentPath = dirname(operation.absolutePath);
        const targetName = basename(operation.absolutePath);
        this.withPinnedParent(parentPath, operation.parent, () => {
          const state = lstatSnapshot(targetName, this.fileSystem);
          observedState = state;
          generated = state.exists ? snapshotWithHash(targetName, state, this.fileSystem) : state;
        });
      } catch (error) {
        if (error instanceof CwdRestorationError) retainedRestoreCwd ??= error.restoreCwd;
        /* retain the metadata binding below when content read failed */
      }
    }
    generated ??= committedTarget ?? observedState;
    // The intended generated content is known independently of verification;
    // this makes a one-shot injected verification failure recoverable even if
    // the first post-rename read could not capture complete metadata. If the
    // target is observed missing, recovery remains bound to that absence and
    // can safely recreate it from the verified backup.
    generated ??= { exists: true, hash: operation.contentHash };
    const token = randomBytes(DOCTOR_APPLY_TOKEN_BYTES).toString("hex");
    return { token, root, operation, backupPath, backupDirectory, backupHash, generated, parent: operation.parent, ...(retainedRestoreCwd ? { restoreCwd: retainedRestoreCwd } : {}), expiresAt: appliedAt + DOCTOR_APPLY_TOKEN_TTL_MS };
  }

  private removeBackupPath(backupPath: string, backupDirectory: string): void {
    try { this.fileSystem.unlinkSync(backupPath); } catch { /* cleanup is idempotent */ }
    try { this.fileSystem.rmdirSync(backupDirectory); } catch { /* cleanup is idempotent */ }
  }

  private writeExclusive(path: string, data: Buffer): Buffer {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    let fd: number | undefined;
    try {
      fd = this.fileSystem.openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
      let offset = 0;
      while (offset < data.byteLength) {
        const count = this.fileSystem.writeSync(fd, data, offset, data.byteLength - offset, offset);
        if (count <= 0 || count > data.byteLength - offset) throw new DoctorApplyError("write", "Filesystem returned an invalid write length.");
        offset += count;
      }
      this.fileSystem.fsyncSync(fd);
      this.fileSystem.closeSync(fd);
      fd = undefined;
      return Buffer.from(data);
    } finally {
      if (fd !== undefined) {
        try { this.fileSystem.closeSync(fd); } catch { /* best effort */ }
      }
    }
  }

  private writeTempFile(parent: string, data: Buffer, pinned = false): { directory: string; file: string } {
    // A pinned project temp must be created through `.` as well. An absolute
    // parent path here would reintroduce the very parent-component TOCTOU that
    // the final rename/link protection is intended to close.
    if (pinned) {
      let directory: string;
      try { directory = this.fileSystem.mkdtempSync(".godmode-doctor-write-"); }
      catch { throw new DoctorApplyError("write", "Pinned target parent could not create a temporary file."); }
      try { this.fileSystem.chmodSync(directory, 0o700); } catch { /* best effort */ }
      const file = join(directory, "content");
      try {
        this.writeExclusive(file, data);
      } catch (error) {
        try { this.fileSystem.unlinkSync(file); } catch { /* idempotent cleanup */ }
        try { this.fileSystem.rmdirSync(directory); } catch { /* idempotent cleanup */ }
        throw error;
      }
      return { directory, file };
    }

    // Legacy/non-pinned callers use an OS temporary directory when it is on
    // the same device, with a sibling fallback when it is not.
    let temporaryParent = tmpdir();
    try {
      const projectDevice = this.fileSystem.lstatSync(parent).dev;
      const tempDevice = this.fileSystem.lstatSync(temporaryParent).dev;
      if (Number(projectDevice) !== Number(tempDevice)) temporaryParent = parent;
    } catch { temporaryParent = parent; }
    let directory: string;
    try { directory = this.fileSystem.mkdtempSync(join(temporaryParent, temporaryParent === parent ? ".godmode-doctor-write-" : "godmode-doctor-write-")); }
    catch { directory = this.fileSystem.mkdtempSync(join(parent, ".godmode-doctor-write-")); }
    try { this.fileSystem.chmodSync(directory, 0o700); } catch { /* best effort */ }
    const file = join(directory, "content");
    try {
      this.writeExclusive(file, data);
    } catch (error) {
      try { this.fileSystem.unlinkSync(file); } catch { /* idempotent cleanup */ }
      try { this.fileSystem.rmdirSync(directory); } catch { /* idempotent cleanup */ }
      throw error;
    }
    return { directory, file };
  }

  private syncFile(path: string): void {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    let fd: number | undefined;
    try {
      fd = this.fileSystem.openSync(path, fsConstants.O_RDONLY | noFollow);
      this.fileSystem.fsyncSync(fd);
    } finally {
      if (fd !== undefined) {
        try { this.fileSystem.closeSync(fd); } catch { /* best effort after a write */ }
      }
    }
  }

  private verifyFile(path: string, expectedHash: string): DoctorApplyTargetSnapshot {
    assertParentNoFollow(path, this.fileSystem);
    const current = lstatSnapshot(path, this.fileSystem);
    const actual = snapshotWithHash(path, current, this.fileSystem);
    if (!actual.hash || actual.hash !== expectedHash) throw new DoctorApplyError("verify", `Written target hash did not verify: ${path}`);
    return actual;
  }

  private removeTemp(temp: { directory: string; file: string }): void {
    try { this.fileSystem.unlinkSync(temp.file); } catch { /* cleanup is idempotent */ }
    try { this.fileSystem.rmdirSync(temp.directory); } catch { /* cleanup is idempotent */ }
  }

  private recoveryTargetSnapshot(path: string, expected: DoctorApplyTargetSnapshot): DoctorApplyTargetSnapshot {
    const actual = lstatSnapshot(path, this.fileSystem);
    if (!actual.exists) return actual;
    // Always attempt a bounded content read. A prior recovery rename may have
    // installed the backup bytes and changed size/mtime, so an early metadata
    // return would make an otherwise safe retry look like a target mismatch.
    // sameRecoveryTarget still compares every metadata field that was captured
    // for the generated target after the hash is available.
    try { return readRegular(path, actual, this.fileSystem).snapshot; }
    catch (error) {
      // A fallback handle may exist specifically because target content could
      // not be read after commit. Metadata identity still permits a bounded
      // recovery attempt; normal handles retain their stricter hash proof.
      if (expected.hash === undefined) return actual;
      throw error;
    }
  }

  private readBackup(entry: RecoveryEntry): Buffer {
    const stat = lstatSnapshot(entry.backupPath, this.fileSystem);
    if (!stat.exists || stat.size === undefined || stat.size > DOCTOR_APPLY_MAX_BACKUP_BYTES) throw new DoctorApplyError("recovery", "Recovery backup is unavailable or unsafe.");
    const data = readRegular(entry.backupPath, stat, this.fileSystem).data;
    if (hash(data) !== entry.backupHash) throw new DoctorApplyError("recovery", "Recovery backup hash changed.");
    return data;
  }

  private removeBackup(entry: RecoveryEntry): void {
    try { this.fileSystem.unlinkSync(entry.backupPath); } catch { /* idempotent cleanup */ }
    try { this.fileSystem.rmdirSync(entry.backupDirectory); } catch { /* idempotent cleanup */ }
    this.backupBytes = Math.max(0, this.backupBytes - (entry.operation.target.size ?? 0));
  }

  private storeRecovery(entry: RecoveryEntry): void {
    this.recoveries.set(entry.token, entry);
    this.backupBytes += entry.operation.target.size ?? 0;
  }

  private withLock<T>(action: () => T): T {
    // Process cwd is shared by all manager instances. A per-instance mutex is
    // insufficient: a nested call through another manager could chdir while a
    // pinned operation is still using relative basenames.
    if (this.locked || processCwdGuardHeld) throw new DoctorApplyError("mutex", "Another doctor apply or recovery operation is active in this process.");
    this.locked = true;
    processCwdGuardHeld = true;
    try { return action(); } finally {
      processCwdGuardHeld = false;
      this.locked = false;
    }
  }

  private result(status: DoctorApplyResult["status"], applied: string[], failed: Array<{ path: string; reason: string }>, warnings: string[], operations: Array<{ path: string; status: "applied" | "failed"; reason?: string }> = [], recoveryToken?: string): DoctorApplyResult {
    const boundedFailed = failed.slice(0, DOCTOR_APPLY_PATHS.length + 1).map((item) => ({ path: bounded(item.path, 160), reason: bounded(item.reason, 512) }));
    const boundedWarnings = warnings.slice(0, 8).map((item) => bounded(item, 512));
    const boundedOperations = operations.slice(0, DOCTOR_APPLY_PATHS.length).map((item) => ({ ...item, ...(item.reason ? { reason: bounded(item.reason, 512) } : {}) }));
    const result: DoctorApplyResult = { schema: "godmode-doctor-apply-result", schemaVersion: 1, status, applied: applied.slice(0, DOCTOR_APPLY_PATHS.length), failed: boundedFailed, warnings: boundedWarnings, operations: boundedOperations, ...(recoveryToken ? { recoveryToken } : {}), rendered: "" };
    result.rendered = JSON.stringify(result, null, 2);
    return result;
  }

  private recoveryResult(status: DoctorApplyRecoveryResult["status"], path?: string, reason?: string, recoveryToken?: string): DoctorApplyRecoveryResult {
    const result: DoctorApplyRecoveryResult = { schema: "godmode-doctor-apply-recovery-result", schemaVersion: 1, status, ...(path ? { path: bounded(path, 160) } : {}), ...(reason ? { reason: bounded(reason, 512) } : {}), ...(recoveryToken ? { recoveryToken } : {}), rendered: "" };
    result.rendered = JSON.stringify(result, null, 2);
    return result;
  }
}

let defaultManager: DoctorApplyManager | undefined;

export function getDoctorApplyManager(): DoctorApplyManager {
  defaultManager ??= new DoctorApplyManager();
  return defaultManager;
}

export function createDoctorApplyManager(options: ConstructorParameters<typeof DoctorApplyManager>[0] = {}): DoctorApplyManager {
  return new DoctorApplyManager(options);
}

export function createDoctorApplyPreview(root: string, report: DoctorReport, options: DoctorApplyOptions = {}): DoctorApplyPreview {
  return (options.manager ?? getDoctorApplyManager()).createDoctorApplyPreview(root, report, options);
}

export function applyDoctorPreview(root: string, token: string, options: DoctorApplyOptions = {}): DoctorApplyResult {
  return (options.manager ?? getDoctorApplyManager()).applyDoctorPreview(root, token, options);
}

export function recoverDoctorPreview(root: string, token: string, options: DoctorApplyOptions = {}): DoctorApplyRecoveryResult {
  return (options.manager ?? getDoctorApplyManager()).recoverDoctorPreview(root, token, options);
}

/** Remove in-memory previews/backups. The helper never touches project files. */
export function cleanupDoctorApply(): void {
  defaultManager?.cleanup();
}
