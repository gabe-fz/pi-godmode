import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep, join } from "node:path";
import { tmpdir } from "node:os";
import { TextDecoder } from "node:util";
import type { BoundedEvidenceReference } from "./types.ts";
import { containsSecretLikeContent, isSecretLikeFilename, scavengeGodmodeTempDirectories, type TempScavengeOptions } from "./security-text.ts";

/** Bounded artifact importer limits. Raw evidence never enters the ledger. */
export const EVIDENCE_MAX_FILES = 64;
export const EVIDENCE_MAX_FILE_BYTES = 1 * 1024 * 1024;
export const EVIDENCE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const EVIDENCE_ARTIFACT_TTL_MS = 15 * 60 * 1000;
const EVIDENCE_DIRECTORY_PREFIX = "pi-godmode-evidence-";
const SHA256 = /^[0-9a-f]{64}$/u;

export interface EvidenceArtifactDescriptor extends BoundedEvidenceReference {
  kind: string;
  source: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  expiresAt: string;
  retentionClass: "session" | "review" | "durable";
}

export interface EvidenceArtifactInput {
  path: string;
  kind?: string;
  label?: string;
}

export interface EvidenceImportOptions {
  /** Active checkout root. Relative input paths are resolved here. */
  cwd?: string;
  /** Additional explicitly approved OS temporary roots. */
  approvedTempRoots?: string[];
  now?: Date;
  expiresAt?: string;
  retentionClass?: "session" | "review" | "durable";
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface EvidenceImportResult {
  artifacts: EvidenceArtifactDescriptor[];
  directory: string;
  totalBytes: number;
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function canonicalNow(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Evidence clock is invalid.");
  const output = value.toISOString();
  if (!timestamp(output)) throw new Error("Evidence clock is not canonical.");
  return output;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined ? fallback : Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : (() => { throw new Error("Evidence import limits are invalid."); })();
}

function activeContentLike(value: string): boolean {
  return /(?:<script(?:\s|>)|<iframe(?:\s|>)|<object(?:\s|>)|<embed(?:\s|>)|javascript\s*:|data\s*:\s*text\/(?:html|javascript)|\bon[a-z][a-z0-9_-]*\s*=)/iu.test(value);
}

function safeText(content: Buffer, source: string): string {
  if (content.includes(0)) throw new Error(`Evidence artifact contains NUL/binary data and is unsafe: ${source}`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`Evidence artifact is not valid UTF-8 text: ${source}`);
  }
  // Reject control-heavy payloads while permitting normal tabs/newlines. This
  // prevents arbitrary binary/active payloads from being mistaken for proof.
  const controls = [...text].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
  }).length;
  if (text.length > 0 && controls / text.length > 0.01) throw new Error(`Evidence artifact contains unsafe binary control data: ${source}`);
  if (activeContentLike(text)) throw new Error(`Evidence artifact contains embedded active content: ${source}`);
  if (containsSecretLikeContent(text)) throw new Error(`Evidence artifact contains secret-like credentials or signed URL data: ${source}`);
  return text;
}

function approvedRoots(cwd: string | undefined, extra: readonly string[] | undefined): string[] {
  const roots: string[] = [];
  const add = (value: string): void => {
    try {
      const root = realpathSync(value);
      if (!roots.includes(root)) roots.push(root);
    } catch {
      throw new Error(`Evidence approved root is unavailable: ${value}`);
    }
  };
  add(cwd ?? process.cwd());
  add(tmpdir());
  for (const root of extra ?? []) {
    if (typeof root !== "string" || !root.trim() || root.includes("\0")) throw new Error("Evidence approved temporary roots are malformed.");
    add(root);
  }
  return roots;
}

function inputValue(raw: string | EvidenceArtifactInput): EvidenceArtifactInput {
  if (typeof raw === "string") return { path: raw };
  if (!raw || typeof raw !== "object" || typeof raw.path !== "string" || !raw.path.trim()) throw new Error("Evidence artifact input must identify an explicit path.");
  if (raw.kind !== undefined && (typeof raw.kind !== "string" || !raw.kind.trim() || Buffer.byteLength(raw.kind, "utf8") > 256)) throw new Error("Evidence artifact kind is malformed or unbounded.");
  if (raw.label !== undefined && (typeof raw.label !== "string" || !raw.label.trim() || Buffer.byteLength(raw.label, "utf8") > 1024)) throw new Error("Evidence artifact label is malformed or unbounded.");
  return { path: raw.path, ...(raw.kind !== undefined ? { kind: raw.kind } : {}), ...(raw.label !== undefined ? { label: raw.label } : {}) };
}

function sourcePath(path: string, cwd: string | undefined, roots: readonly string[]): { absolute: string; canonical: string } {
  if (!path.trim() || path.includes("\0")) throw new Error("Evidence artifact path is malformed.");
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd ?? process.cwd(), path);
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
    const link = lstatSync(absolute);
    if (!link.isFile() || link.isSymbolicLink()) throw new Error("not a regular non-symlink file");
    const stats = statSync(absolute);
    if (!stats.isFile()) throw new Error("not a regular file");
  } catch {
    throw new Error(`Evidence artifact is missing, inaccessible, or not a regular non-symlink file: ${path}`);
  }
  if (!roots.some((root) => isInside(root, canonical))) throw new Error(`Evidence artifact path is outside the checkout and approved OS-temp roots: ${path}`);
  if (isSecretLikeFilename(absolute)) throw new Error("Evidence refuses secret-like credential filenames.");
  return { absolute, canonical };
}

function safeOutputDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), EVIDENCE_DIRECTORY_PREFIX));
  chmodSync(directory, 0o700);
  return directory;
}

/** Import explicit, passive text artifacts into an owner-only temporary area. */
export function importEvidenceArtifacts(
  inputs: readonly (string | EvidenceArtifactInput)[],
  options: EvidenceImportOptions = {},
): EvidenceImportResult {
  // This bounded detector is read-only; explicit lifecycle cleanup below is
  // the only cleanup path for artifacts held by the current session.
  scavengeGodmodeTempDirectories();
  if (!Array.isArray(inputs)) throw new Error("Evidence artifact inputs must be an array.");
  const maxFiles = boundedInteger(options.maxFiles, EVIDENCE_MAX_FILES, EVIDENCE_MAX_FILES);
  const maxFileBytes = boundedInteger(options.maxFileBytes, EVIDENCE_MAX_FILE_BYTES, EVIDENCE_MAX_FILE_BYTES);
  const maxTotalBytes = boundedInteger(options.maxTotalBytes, EVIDENCE_MAX_TOTAL_BYTES, EVIDENCE_MAX_TOTAL_BYTES);
  if (inputs.length === 0 || inputs.length > maxFiles) throw new Error(`Evidence artifact count exceeds the bounded limit of ${maxFiles}.`);
  const now = options.now ?? new Date();
  const createdAt = canonicalNow(now);
  const expiresAt = options.expiresAt ?? new Date(now.getTime() + EVIDENCE_ARTIFACT_TTL_MS).toISOString();
  if (!timestamp(expiresAt) || Date.parse(expiresAt) <= Date.parse(createdAt)) throw new Error("Evidence artifact expiry must be a future canonical UTC timestamp.");
  const retentionClass = options.retentionClass ?? "session";
  if (retentionClass !== "session" && retentionClass !== "review" && retentionClass !== "durable") throw new Error("Evidence retention class is invalid.");
  const roots = approvedRoots(options.cwd, options.approvedTempRoots);
  const directory = safeOutputDirectory();
  const descriptors: EvidenceArtifactDescriptor[] = [];
  const identities = new Set<string>();
  let totalBytes = 0;
  try {
    for (const [index, raw] of inputs.entries()) {
      const input = inputValue(raw);
      const source = sourcePath(input.path, options.cwd, roots);
      const content = readFileSync(source.canonical);
      if (content.byteLength > maxFileBytes) throw new Error(`Evidence artifact exceeds its bounded per-file size: ${input.path}`);
      totalBytes += content.byteLength;
      if (totalBytes > maxTotalBytes) throw new Error(`Evidence artifacts exceed their bounded total size of ${maxTotalBytes} bytes.`);
      safeText(content, input.path);
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (identities.has(sha256)) throw new Error("Evidence artifact inputs contain duplicate content identities.");
      identities.add(sha256);
      const name = `${String(index).padStart(2, "0")}-${sha256.slice(0, 24)}.txt`;
      const output = join(directory, name);
      writeFileSync(output, content, { mode: 0o600, flag: "wx" });
      chmodSync(output, 0o600);
      descriptors.push({
        id: `evidence-${sha256.slice(0, 24)}`,
        kind: input.kind ?? "primary-observed-artifact",
        label: input.label ?? basename(input.path),
        source: output,
        sha256,
        bytes: content.byteLength,
        createdAt,
        expiresAt,
        retentionClass,
      });
    }
    return { artifacts: descriptors, directory, totalBytes };
  } catch (error) {
    cleanupEvidenceArtifacts(directory);
    throw error;
  }
}

/** Singular convenience wrapper for controller/tests that import one file. */
export function importEvidenceArtifact(input: string | EvidenceArtifactInput, options: EvidenceImportOptions = {}): EvidenceArtifactDescriptor {
  return importEvidenceArtifacts([input], options).artifacts[0]!;
}

function descriptor(value: unknown): EvidenceArtifactDescriptor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !candidate.id.trim() || Buffer.byteLength(candidate.id, "utf8") > 256
    || typeof candidate.kind !== "string" || !candidate.kind.trim() || Buffer.byteLength(candidate.kind, "utf8") > 256
    || (candidate.label !== undefined && (typeof candidate.label !== "string" || Buffer.byteLength(candidate.label, "utf8") > 1024))
    || typeof candidate.source !== "string" || !isAbsolute(candidate.source) || Buffer.byteLength(candidate.source, "utf8") > 4096
    || typeof candidate.sha256 !== "string" || !SHA256.test(candidate.sha256)
    || typeof candidate.bytes !== "number" || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0 || candidate.bytes > EVIDENCE_MAX_FILE_BYTES
    || !timestamp(candidate.createdAt) || !timestamp(candidate.expiresAt) || Date.parse(candidate.expiresAt) <= Date.parse(candidate.createdAt)
    || (candidate.retentionClass !== undefined && candidate.retentionClass !== "session" && candidate.retentionClass !== "review" && candidate.retentionClass !== "durable")) return undefined;
  return candidate as unknown as EvidenceArtifactDescriptor;
}

function readVerified(value: unknown, now: Date): boolean {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return false;
  const item = descriptor(value);
  if (!item) return false;
  const createdAt = Date.parse(item.createdAt);
  const expiresAt = Date.parse(item.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt > now.getTime() || expiresAt <= now.getTime() || expiresAt <= createdAt) return false;
  try {
    const path = resolve(item.source);
    const root = realpathSync(tmpdir());
    const parent = realpathSync(dirname(path));
    if (!basename(parent).startsWith(EVIDENCE_DIRECTORY_PREFIX) || !isInside(root, parent)) return false;
    const link = lstatSync(path);
    if (!link.isFile() || link.isSymbolicLink() || link.size !== item.bytes) return false;
    const canonical = realpathSync(path);
    if (!isInside(root, canonical)) return false;
    const content = readFileSync(canonical);
    if (content.byteLength !== item.bytes || createHash("sha256").update(content).digest("hex") !== item.sha256) return false;
    safeText(content, item.id);
    return true;
  } catch {
    return false;
  }
}

/** Verify current presence, expiry, hash, size, and secret-free content. */
export function verifyEvidenceArtifact(value: EvidenceArtifactDescriptor | BoundedEvidenceReference, now = new Date()): boolean {
  return readVerified(value, now);
}

export function verifyEvidenceArtifacts(values: readonly (EvidenceArtifactDescriptor | BoundedEvidenceReference)[], now = new Date()): boolean {
  return Array.isArray(values) && values.length > 0 && values.every((value) => readVerified(value, now));
}

/** Idempotent cleanup accepts either an import directory or descriptors. */
export function cleanupEvidenceArtifacts(value: string | ReadonlyArray<EvidenceArtifactDescriptor | BoundedEvidenceReference>): void {
  const directories = new Set<string>();
  if (typeof value === "string") directories.add(value);
  else for (const artifact of value) if (artifact && typeof artifact.source === "string") directories.add(dirname(artifact.source));
  const root = resolve(tmpdir());
  for (const directory of directories) {
    try {
      const absolute = resolve(directory);
      if (!absolute.startsWith(`${root}${sep}`) || !basename(absolute).startsWith(EVIDENCE_DIRECTORY_PREFIX)) continue;
      rmSync(absolute, { recursive: true, force: true, maxRetries: 1 });
    } catch {
      // Cleanup is intentionally idempotent and best effort; verification fails closed.
    }
  }
}

export const cleanupEvidenceArtifactDirectory = cleanupEvidenceArtifacts;

/** Bounded startup/shutdown detection of stale evidence directories; no crash-leftover deletion is attempted. */
export function scavengeEvidenceArtifactDirectories(options: TempScavengeOptions = {}): number {
  return scavengeGodmodeTempDirectories(options);
}
export const scavengeEvidenceArtifacts = scavengeEvidenceArtifactDirectories;
