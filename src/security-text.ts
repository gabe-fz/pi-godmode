/** Shared conservative detector for credential-bearing paths and text.
 *
 * This module intentionally answers only "unsafe or not". Callers handling
 * authority evidence must reject an unsafe value rather than attempt to make
 * it safe by redaction. It has no filesystem or network dependencies.
 */

const SECRET_FILENAME = /(?:^|[\\/._-])(?:\.env(?:\.|$)|credentials?(?:[._-]|$)|secrets?(?:[._-]|$)|tokens?(?:[._-]|$)|passwords?(?:[._-]|$)|passwd(?:[._-]|$)|private[ _.-]?keys?(?:[._-]|$)|(?:id[_-]?|)rsa(?:[._-]|$)|id[_-]?ed25519(?:[._-]|$)|(?:api|access)[._-]?keys?(?:[._-]|$)|(?:api|access)[._-]?tokens?(?:[._-]|$))/iu;

// Values are intentionally required for names such as token/password. This
// avoids rejecting ordinary prose that discusses the security policy while
// still catching header, env, JSON, URL, JWT, and cloud-credential forms.
const SECRET_CONTENT = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/iu,
  /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*\S+/iu,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\bbasic\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:password|passwd|passphrase|token|secret|credential|api[ _-]?key|access[ _-]?key|access[ _-]?token|id[ _-]?token|refresh[ _-]?token|client[ _-]?secret|private[ _-]?key)\s*(?:[:=]|=>)\s*["']?[^\s"',;&}]+/iu,
  /[?&](?:x-amz-(?:signature|security-token)|signature|sig|access[_-]?token|api[_-]?key|token|secret|password|credential)=[^&#\s]+/iu,
  /\b(?:aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token)|google[_-]?application[_-]?credentials|azure[_-]?(?:client[_-]?secret|access[_-]?token))\s*(?:[:=]|=>)\s*["']?[^\s"',;&}]+/iu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{20,}\b/u,
  /\b(?:gh[pousr]|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{8,}\b/iu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/u,
];
const ACTIVE_CONTENT = /(?:<script(?:\s|>)|<iframe(?:\s|>)|<object(?:\s|>)|<embed(?:\s|>)|javascript\s*:|data\s*:\s*text\/(?:html|javascript)|\bon[a-z][a-z0-9_-]*\s*=)/iu;

/** Return true for a path whose filename convention indicates credentials. */
export function isSecretLikeFilename(value: string): boolean {
  return typeof value === "string" && value.length > 0 && SECRET_FILENAME.test(value);
}

/** Return true when text contains a credential, private key, or signed URL. */
export function containsSecretLikeContent(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  return SECRET_CONTENT.some((pattern) => pattern.test(value));
}

/** Return true for HTML/script or other active payload markers. */
export function containsActiveContent(value: string): boolean {
  return typeof value === "string" && ACTIVE_CONTENT.test(value);
}

/** Replace recognized secret values for non-authority presentation only. */
export function redactSecretLikeContent(value: string): string {
  if (typeof value !== "string") return "[REDACTED]";
  let result = value;
  result = result.replace(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]");
  result = result.replace(/(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)\S+/giu, "$1[REDACTED]");
  result = result.replace(/(\bbearer\s+)\S+/giu, "$1[REDACTED]");
  result = result.replace(/([?&](?:x-amz-(?:signature|security-token)|signature|sig|access[_-]?token|api[_-]?key|token|secret|password|credential)=)[^&#\s]+/giu, "$1[REDACTED]");
  return result.replace(/(\b(?:password|passwd|passphrase|token|secret|credential|api[ _-]?key|access[ _-]?key|access[ _-]?token|id[ _-]?token|refresh[ _-]?token|client[ _-]?secret|private[ _-]?key)\s*(?:[:=]|=>)\s*["']?)[^\s"',;&}]+/giu, "$1[REDACTED]");
}

export type GodmodeTempPrefix = "pi-godmode-inspection-" | "pi-godmode-evidence-" | "godmode-doctor-recovery-";
export const GODMODE_TEMP_PREFIXES: readonly GodmodeTempPrefix[] = [
  "pi-godmode-inspection-",
  "pi-godmode-evidence-",
  "godmode-doctor-recovery-",
];

export interface TempScavengeOptions {
  now?: Date;
  /** Test seam; must still resolve inside the host OS temporary directory. */
  tmpRoot?: string;
  ttlMs?: number;
  maxEntriesPerPrefix?: number;
}

/**
 * Detect expired, direct-child, owner-prefix directories in tmpdir without
 * mutating the filesystem. Node does not provide identity-conditional
 * recursive deletion/openat primitives here, so pathname-based crash cleanup
 * would remain vulnerable to a late same-user rename. The return value is the
 * bounded number of stale regular directories observed; callers must leave
 * crash leftovers to host OS temporary-file retention.
 */
export function scavengeGodmodeTempDirectories(options: TempScavengeOptions = {}): number {
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return 0;
  const ttl = options.ttlMs ?? 15 * 60 * 1000;
  const maxEntries = options.maxEntriesPerPrefix ?? 64;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) return 0;
  let fs: typeof import("node:fs");
  let pathApi: typeof import("node:path");
  let os: typeof import("node:os");
  try {
    // Static imports are intentionally avoided only to keep this helper's
    // test seam small in stripped-type Node runtimes.
    fs = requireFs();
    pathApi = requirePath();
    os = requireOs();
  } catch { return 0; }
  let hostTmp: string;
  const requested = pathApi.resolve(options.tmpRoot ?? os.tmpdir());
  let root: string;
  try {
    hostTmp = fs.realpathSync(pathApi.resolve(os.tmpdir()));
    root = fs.realpathSync(requested);
  } catch { return 0; }
  if (!inside(hostTmp, root)) return 0;
  let names: string[];
  try { names = fs.readdirSync(root, { encoding: "utf8" }); } catch { return 0; }
  let stale = 0;
  for (const prefix of GODMODE_TEMP_PREFIXES) {
    const candidates = names.filter((name) => name.startsWith(prefix)).sort().slice(0, maxEntries);
    for (const name of candidates) {
      const candidate = pathApi.resolve(root, name);
      if (pathApi.dirname(candidate) !== root || !inside(hostTmp, candidate)) continue;
      try {
        const stat = fs.lstatSync(candidate);
        // Symlinks and non-directories are observed but never traversed. A
        // later pathname swap is harmless because this detector has no write
        // or deletion primitive at all.
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mtimeMs > now.getTime() - ttl) continue;
        stale += 1;
      } catch { /* best-effort detection; active verification remains strict */ }
    }
  }
  return stale;
}

function inside(root: string, candidate: string): boolean {
  const pathApi = requirePath();
  const value = pathApi.relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(value));
}

// These wrappers preserve the public detector API without exposing filesystem
// implementation details to callers.
export function scavengeInspectionArtifacts(options: TempScavengeOptions = {}): number {
  return scavengeGodmodeTempDirectories(options);
}
export function scavengeEvidenceArtifacts(options: TempScavengeOptions = {}): number {
  return scavengeGodmodeTempDirectories(options);
}
export function scavengeDoctorRecoveryArtifacts(options: TempScavengeOptions = {}): number {
  return scavengeGodmodeTempDirectories(options);
}

// Node's ESM runtime has no require. Keeping these tiny functions at the end
// gives TypeScript a precise module shape; they are replaced by static imports
// below through ordinary namespace bindings at evaluation time.
import * as fsModule from "node:fs";
import * as pathModule from "node:path";
import * as osModule from "node:os";
const requireFs = (): typeof import("node:fs") => fsModule;
const requirePath = (): typeof import("node:path") => pathModule;
const requireOs = (): typeof import("node:os") => osModule;
