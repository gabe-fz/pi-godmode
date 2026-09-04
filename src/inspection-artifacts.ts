import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { BoundedEvidenceReference, PrimaryInspection } from "./types.ts";
import { containsSecretLikeContent, isSecretLikeFilename, scavengeGodmodeTempDirectories, type TempScavengeOptions } from "./security-text.ts";

/**
 * Inspection artifacts are deliberately outside the workflow ledger.  Git is
 * invoked with fixed argv and an explicit cwd; no caller text is ever treated
 * as a command and inspection never writes to the checkout or index.
 */
export const INSPECTION_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export const INSPECTION_STATUS_MAX_BYTES = 512 * 1024;
export const INSPECTION_FILE_MAX_BYTES = 1024 * 1024;
export const INSPECTION_MAX_PATHS = 256;
export const INSPECTION_ARTIFACT_TTL_MS = 15 * 60 * 1000;
const ARTIFACT_DIRECTORY_PREFIX = "pi-godmode-inspection-";
const SHA256 = /^[0-9a-f]{64}$/u;

export interface InspectionArtifactReference extends BoundedEvidenceReference {
  kind: "git-status" | "git-complete-diff";
  source: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  expiresAt: string;
}

export interface CheckoutSnapshot {
  status: Buffer;
  completeDiff: Buffer;
  fingerprint: string;
  changedPaths: string[];
}

export interface CapturedInspectionArtifacts extends CheckoutSnapshot {
  statusReference: InspectionArtifactReference;
  completeDiffReference: InspectionArtifactReference;
  artifactDirectory: string;
}

function isPathInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function canonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function boundedBuffer(value: Buffer, maximum: number, label: string): Buffer {
  if (value.byteLength > maximum) throw new Error(`${label} exceeds its bounded size.`);
  return value;
}

function runGit(cwd: string, argv: readonly string[], maximum: number): Buffer {
  // execFileSync does not invoke a shell. The argv below are constants except
  // for the trusted checkout cwd supplied by extension plumbing.
  try {
    const output = execFileSync("git", [...argv], {
      cwd,
      encoding: "buffer",
      maxBuffer: maximum,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return Buffer.isBuffer(output) ? boundedBuffer(output, maximum, "Git inspection output") : Buffer.from(output);
  } catch (error) {
    throw new Error(`Unable to capture the trusted checkout with fixed git inspection: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function statusPaths(status: Buffer): string[] {
  const values = status.toString("utf8").split("\0");
  const paths: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const entry = values[index];
    if (!entry) continue;
    // Porcelain v1 -z has XY<space>path. Rename/copy entries carry a second
    // NUL-delimited path; retain both names so deletion and creation cannot be
    // hidden by a rename summary.
    if (entry.length < 4) throw new Error("Git returned malformed status output.");
    const statusCode = entry.slice(0, 2);
    const firstPath = entry.slice(3);
    if (!firstPath || firstPath.includes("\0")) throw new Error("Git returned malformed status path output.");
    paths.push(firstPath);
    if (statusCode.includes("R") || statusCode.includes("C")) {
      const next = values[index + 1];
      if (!next) throw new Error("Git returned an incomplete rename status entry.");
      paths.push(next);
      index += 1;
    }
  }
  return [...new Set(paths)];
}

function validateCheckoutPath(root: string, value: string): string {
  if (!value || value.startsWith("/") || value.split(/[\\/]/u).includes("..")) {
    throw new Error("Git returned an unsafe checkout path.");
  }
  const lexical = resolve(root, value);
  if (!isPathInside(root, lexical)) throw new Error("Git returned a checkout path outside the active root.");
  // Existing changed paths must not resolve through a symlink. For deleted
  // paths, inspect the nearest existing ancestor as well: a deletion beneath
  // a symlinked directory must not turn an escaped path into a safe-looking
  // lexical name.
  const existing = existsSync(lexical) ? lexical : (() => {
    let cursor = lexical;
    while (!existsSync(cursor)) {
      const parent = dirname(cursor);
      if (parent === cursor) return cursor;
      cursor = parent;
    }
    return cursor;
  })();
  const canonicalExisting = realpathSync(existing);
  if (!isPathInside(root, canonicalExisting)) throw new Error(`Changed checkout path escapes the checkout: ${value}`);
  if (existsSync(lexical)) {
    const link = lstatSync(lexical);
    if (link.isSymbolicLink()) throw new Error(`Changed checkout path is symlink-unsafe: ${value}`);
    const canonical = realpathSync(lexical);
    if (!isPathInside(root, canonical)) throw new Error(`Changed checkout path escapes the checkout: ${value}`);
  }
  return value;
}

function appendUntrackedContent(cwd: string, changedPaths: readonly string[], trackedDiff: Buffer, status: Buffer): Buffer {
  const root = realpathSync(cwd);
  let output = Buffer.from(trackedDiff);
  const statusEntries = status.toString("utf8").split("\0");
  const untracked = new Set<string>();
  for (const entry of statusEntries) {
    if (entry.startsWith("?? ")) untracked.add(entry.slice(3));
  }
  for (const path of [...untracked].sort()) {
    if (!changedPaths.includes(path)) throw new Error("Git status path set was internally inconsistent.");
    const absolute = resolve(root, path);
    const link = lstatSync(absolute);
    if (!link.isFile() || link.isSymbolicLink()) throw new Error(`Untracked changed path is not a safe regular file: ${path}`);
    if (link.size > INSPECTION_FILE_MAX_BYTES) throw new Error(`Untracked changed file exceeds its bounded size: ${path}`);
    if (isSecretLikeFilename(path)) throw new Error(`Secret-like changed filename cannot become a Scale inspection artifact: ${path}`);
    const content = readFileSync(absolute);
    if (content.includes(0) || containsSecretLikeContent(content.toString("utf8"))) {
      throw new Error(`Secret-bearing or active untracked content cannot become a Scale inspection artifact: ${path}`);
    }
    const marker = Buffer.from(`\n\n--- GODMODE UNTRACKED FILE: ${path} ---\n`, "utf8");
    output = Buffer.concat([output, marker, content]);
    if (output.byteLength > INSPECTION_ARTIFACT_MAX_BYTES) throw new Error("Complete checkout diff exceeds its bounded size.");
  }
  return output;
}

/** Capture the current status, tracked diff, and untracked file contents. */
export function captureCheckoutSnapshot(cwd: string): CheckoutSnapshot {
  const root = realpathSync(cwd);
  const status = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], INSPECTION_STATUS_MAX_BYTES);
  const rawPaths = statusPaths(status);
  if (rawPaths.length > INSPECTION_MAX_PATHS) throw new Error("Checkout changed-file count exceeds the bounded inspection limit.");
  if (rawPaths.some((path) => isSecretLikeFilename(path))) {
    throw new Error("Secret-like changed filename cannot become a Scale inspection artifact; remove or quarantine the secret first.");
  }
  const changedPaths = rawPaths.map((path) => validateCheckoutPath(root, path));
  const trackedDiff = runGit(root, ["diff", "--no-ext-diff", "--binary", "--full-index", "--no-color", "HEAD", "--"], INSPECTION_ARTIFACT_MAX_BYTES);
  if (containsSecretLikeContent(trackedDiff.toString("utf8"))) {
    throw new Error("Secret-bearing checkout diff cannot become a Scale inspection artifact; remove or quarantine the secret first.");
  }
  const completeDiff = appendUntrackedContent(root, changedPaths, trackedDiff, status);
  boundedBuffer(completeDiff, INSPECTION_ARTIFACT_MAX_BYTES, "Complete checkout diff");
  const fingerprint = createHash("sha256")
    .update("godmode-checkout-snapshot-v1\0", "utf8")
    .update(status)
    .update("\0", "utf8")
    .update(completeDiff)
    .digest("hex");
  return { status, completeDiff, fingerprint, changedPaths };
}

function descriptor(path: string, kind: InspectionArtifactReference["kind"], content: Buffer, createdAt: string, expiresAt: string): InspectionArtifactReference {
  const sha256 = createHash("sha256").update(content).digest("hex");
  return {
    id: `inspection-${kind}-${sha256.slice(0, 24)}`,
    kind,
    label: kind === "git-status" ? "bounded checkout status" : "bounded complete checkout diff",
    source: path,
    sha256,
    bytes: content.byteLength,
    createdAt,
    expiresAt,
  };
}

/** Capture and materialize bounded artifacts in an OS temporary directory. */
export function captureInspectionArtifacts(cwd: string, now = new Date()): CapturedInspectionArtifacts {
  const createdAt = now.toISOString();
  if (!canonicalTimestamp(createdAt)) throw new Error("Inspection clock returned a non-canonical timestamp.");
  const expiresAt = new Date(now.getTime() + INSPECTION_ARTIFACT_TTL_MS).toISOString();
  const snapshot = captureCheckoutSnapshot(cwd);
  const artifactDirectory = mkArtifactDirectory();
  try {
    const statusPath = join(artifactDirectory, "status.bin");
    const diffPath = join(artifactDirectory, "complete-diff.bin");
    writeFileSync(statusPath, snapshot.status, { mode: 0o600, flag: "wx" });
    writeFileSync(diffPath, snapshot.completeDiff, { mode: 0o600, flag: "wx" });
    chmodSync(statusPath, 0o600);
    chmodSync(diffPath, 0o600);
    return {
      ...snapshot,
      statusReference: descriptor(statusPath, "git-status", snapshot.status, createdAt, expiresAt),
      completeDiffReference: descriptor(diffPath, "git-complete-diff", snapshot.completeDiff, createdAt, expiresAt),
      artifactDirectory,
    };
  } catch (error) {
    cleanupInspectionArtifactDirectory(artifactDirectory);
    throw new Error(`Unable to materialize bounded inspection artifacts: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mkArtifactDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), ARTIFACT_DIRECTORY_PREFIX));
  chmodSync(directory, 0o700);
  return directory;
}

function artifactReference(value: unknown, expectedKind: InspectionArtifactReference["kind"]): InspectionArtifactReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as unknown as Record<string, unknown>;
  if (candidate.kind !== expectedKind || typeof candidate.source !== "string" || !isAbsolute(candidate.source)
    || typeof candidate.sha256 !== "string" || !SHA256.test(candidate.sha256)
    || typeof candidate.bytes !== "number" || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0
    || typeof candidate.createdAt !== "string" || !canonicalTimestamp(candidate.createdAt)
    || typeof candidate.expiresAt !== "string" || !canonicalTimestamp(candidate.expiresAt)) return undefined;
  return candidate as unknown as InspectionArtifactReference;
}

function readArtifact(reference: InspectionArtifactReference, expectedKind: InspectionArtifactReference["kind"], now = new Date()): Buffer | undefined {
  const maximum = expectedKind === "git-status" ? INSPECTION_STATUS_MAX_BYTES : INSPECTION_ARTIFACT_MAX_BYTES;
  if (reference.kind !== expectedKind || reference.bytes > maximum || reference.bytes < 0
    || Date.parse(reference.expiresAt) <= now.getTime() || Date.parse(reference.expiresAt) <= Date.parse(reference.createdAt)) return undefined;
  try {
    const path = resolve(reference.source);
    const tempRoot = realpathSync(tmpdir());
    const parent = realpathSync(dirname(path));
    if (!basename(path) || !isPathInside(tempRoot, parent) || !basename(parent).startsWith(ARTIFACT_DIRECTORY_PREFIX)) return undefined;
    const link = lstatSync(path);
    if (!link.isFile() || link.isSymbolicLink() || link.size !== reference.bytes) return undefined;
    const canonical = realpathSync(path);
    if (!isPathInside(tempRoot, canonical) || basename(canonical) !== basename(path)) return undefined;
    const bytes = readFileSync(canonical);
    if (bytes.byteLength !== reference.bytes) return undefined;
    if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

/** Verify artifact integrity and compare the live checkout to the inspection. */
export function verifyInspectionArtifacts(cwd: string, inspection: PrimaryInspection, now = new Date()): boolean {
  const status = artifactReference(inspection.statusReference, "git-status");
  const diff = artifactReference(inspection.completeDiffReference, "git-complete-diff");
  // Legacy string references have no trusted artifact identity. They remain
  // usable only for old non-runtime fixtures; a real captured inspection must
  // always carry both hashed descriptors.
  if (!status || !diff) return false;
  const statusBytes = readArtifact(status, "git-status", now);
  const diffBytes = readArtifact(diff, "git-complete-diff", now);
  if (!statusBytes || !diffBytes) return false;
  const snapshot = captureCheckoutSnapshot(cwd);
  if (snapshot.fingerprint !== inspection.diffFingerprint) return false;
  if (createHash("sha256").update(statusBytes).digest("hex") !== status.sha256
    || createHash("sha256").update(diffBytes).digest("hex") !== diff.sha256) return false;
  const expectedPaths = [...new Set([...inspection.materiallyChangedPaths, ...inspection.outOfScopeChanges.map((entry) => entry.path)])].sort();
  return JSON.stringify(expectedPaths) === JSON.stringify([...snapshot.changedPaths].sort());
}

/** Read a verified artifact for inclusion in the fresh Scale assignment. */
export function readInspectionArtifactForContext(reference: string | BoundedEvidenceReference, expectedKind: InspectionArtifactReference["kind"], now = new Date()): string | undefined {
  const descriptorValue = artifactReference(reference, expectedKind);
  if (!descriptorValue) return undefined;
  const bytes = readArtifact(descriptorValue, expectedKind, now);
  return bytes?.toString("utf8");
}

export function inspectionArtifactContextPaths(inspection: PrimaryInspection): string[] {
  const references: Array<{ value: string | BoundedEvidenceReference; kind: InspectionArtifactReference["kind"] }> = [
    { value: inspection.statusReference, kind: "git-status" },
    { value: inspection.completeDiffReference, kind: "git-complete-diff" },
  ];
  return references
    .map(({ value, kind }) => artifactReference(value, kind)?.source)
    .filter((source): source is string => source !== undefined);
}

export function cleanupInspectionArtifactDirectory(directory: string): void {
  try {
    const absolute = resolve(directory);
    if (!basename(absolute).startsWith(ARTIFACT_DIRECTORY_PREFIX) || !absolute.startsWith(resolve(tmpdir()) + sep)) return;
    rmSync(absolute, { recursive: true, force: true, maxRetries: 1 });
  } catch {
    // Explicit lifecycle cleanup is best effort; expiry still makes the
    // artifact unusable because verification fails closed when it is absent,
    // changed, or expired.
  }
}

export function cleanupInspectionArtifacts(inspection: PrimaryInspection): void {
  const paths = [inspection.statusReference, inspection.completeDiffReference]
    .filter((value): value is BoundedEvidenceReference => typeof value === "object" && value !== null && !Array.isArray(value));
  const directories = new Set(paths.map((value) => typeof value.source === "string" ? dirname(value.source) : undefined).filter((value): value is string => value !== undefined));
  for (const directory of directories) cleanupInspectionArtifactDirectory(directory);
}

/** Cleanup a prior acknowledged inspection only after canonical state no
 * longer points at it (remediation, replacement, waiver, or acceptance). */
export function cleanupSupersededInspection(previous: PrimaryInspection | undefined, current: PrimaryInspection | undefined): void {
  if (previous && previous.id !== current?.id) cleanupInspectionArtifacts(previous);
}

/** Bounded startup/shutdown detection of stale inspection artifact directories; no crash-leftover deletion is attempted. */
export function scavengeInspectionArtifactDirectories(options: TempScavengeOptions = {}): number {
  return scavengeGodmodeTempDirectories(options);
}
export const scavengeInspectionArtifacts = scavengeInspectionArtifactDirectories;
