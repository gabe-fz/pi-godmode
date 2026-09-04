import * as nodeFs from "node:fs";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import {
  INTERFACE_METHOD_BY_SURFACE,
  INTERFACE_SURFACES,
  type DoctorCommandCandidate,
  type DoctorConfidence,
  type DoctorBasis,
  type DoctorDocConfigItem,
  type DoctorFinding,
  type DoctorLimits,
  type DoctorProjectType,
  type DoctorProposal,
  type DoctorReport,
  type DoctorReportSummary,
  type DoctorRootIdentity,
  type DoctorSurface,
  type DoctorTestCandidate,
  type DoctorVerificationNeed,
  type InterfaceSurface,
} from "./types.ts";

export const DOCTOR_MAX_DEPTH = 8;
export const DOCTOR_MAX_SCANNED_ENTRIES = 256;
export const DOCTOR_MAX_FILE_BYTES = 256 * 1024;
export const DOCTOR_MAX_AGGREGATE_READ_BYTES = 2 * 1024 * 1024;
export const DOCTOR_MAX_SAFETY_FINDINGS = 64;
export const DOCTOR_MAX_COMMANDS = 64;
export const DOCTOR_MAX_TESTS = 64;
export const DOCTOR_MAX_DOCS_CONFIG = 64;
export const DOCTOR_MAX_SURFACES = 64;
export const DOCTOR_MAX_GAPS = 64;
export const DOCTOR_MAX_PROPOSALS = 64;
export const DOCTOR_MAX_FIELD_BYTES = 4 * 1024;
export const DOCTOR_MAX_REPORT_BYTES = 32 * 1024;
/** Descriptive aliases for host/test callers; all values share the same fixed bounds. */
export const DOCTOR_MAX_ENTRIES = DOCTOR_MAX_SCANNED_ENTRIES;
export const DOCTOR_MAX_TOTAL_READ_BYTES = DOCTOR_MAX_AGGREGATE_READ_BYTES;
export const DOCTOR_MAX_AGGREGATE_BYTES = DOCTOR_MAX_AGGREGATE_READ_BYTES;
export const DOCTOR_MAX_RENDERED_BYTES = DOCTOR_MAX_REPORT_BYTES;
export const DOCTOR_MAX_PATH_TEXT_BYTES = DOCTOR_MAX_FIELD_BYTES;

export const DOCTOR_LIMITS = {
  maxDepth: DOCTOR_MAX_DEPTH,
  maxScannedEntries: DOCTOR_MAX_SCANNED_ENTRIES,
  maxFileBytes: DOCTOR_MAX_FILE_BYTES,
  maxAggregateReadBytes: DOCTOR_MAX_AGGREGATE_READ_BYTES,
  maxSafetyFindings: DOCTOR_MAX_SAFETY_FINDINGS,
  maxCommands: DOCTOR_MAX_COMMANDS,
  maxTests: DOCTOR_MAX_TESTS,
  maxDocsConfig: DOCTOR_MAX_DOCS_CONFIG,
  maxSurfaces: DOCTOR_MAX_SURFACES,
  maxGaps: DOCTOR_MAX_GAPS,
  maxProposals: DOCTOR_MAX_PROPOSALS,
  maxFieldBytes: DOCTOR_MAX_FIELD_BYTES,
  maxReportBytes: DOCTOR_MAX_REPORT_BYTES,
} as const;

export interface DoctorFileSystem {
  lstatSync(path: string): nodeFs.Stats;
  realpathSync(path: string): string;
  readdirSync(path: string): string[];
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): nodeFs.Stats;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
}

/**
 * The file-system seam is intentionally synchronous and narrow.  It exists to
 * test races and read failures; the production implementation below never
 * substitutes a convenience readFile call for the lstat/open/fstat sequence.
 */
type DoctorFileSystemOverrides = Partial<DoctorFileSystem> & Record<string, unknown>;

export interface DoctorOptions {
  activeFaculty?: string;
  fs?: DoctorFileSystemOverrides;
  fileSystem?: DoctorFileSystemOverrides;
  filesystem?: DoctorFileSystemOverrides;
  /** Permit forward-compatible test metadata without making it authority. */
  [key: string]: unknown;
}

interface ScannedFile {
  path: string;
  absolutePath: string;
  depth: number;
}

interface ReadResult {
  text?: string;
  bytes: number;
}

interface DiscoveryState {
  readonly root: string;
  readonly fs: DoctorFileSystem;
  readonly options: DoctorOptions;
  scannedEntries: number;
  aggregateReadBytes: number;
  truncated: boolean;
  truncationReasons: Set<string>;
  blocked: boolean;
  projectTypes: DoctorProjectType[];
  surfaces: DoctorSurface[];
  tests: DoctorTestCandidate[];
  commands: DoctorCommandCandidate[];
  docsConfig: DoctorDocConfigItem[];
  gaps: DoctorFinding[];
  safetyFindings: DoctorFinding[];
  proposals: DoctorProposal[];
  files: ScannedFile[];
  contents: Map<string, string>;
  observedDirectories: Set<string>;
  observedFiles: Set<string>;
}

const SKIP_DIRECTORIES = new Set([".git", "node_modules", "vendor", "build", "dist", "coverage", "cache"]);
const ALLOWED_DIRECTORIES = new Set([
  "src", "app", "apps", "lib", "libs", "bin", "cli", "cmd", "server", "backend", "api", "routes", "packages", "workspace", "workspaces", "services", "modules",
  "web", "frontend", "pages", "components", "public", "static", "tui", "terminal", "test", "tests",
  "spec", "specs", "__tests__", "e2e", "integration", "fixtures", "examples", "docs", "doc", "data",
  "db", "database", "migrations", "migration", ".github", ".circleci", ".gitlab", ".godmode", "config",
]);
const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".css", ".go", ".h", ".html", ".java", ".js", ".jsx", ".json", ".kt", ".mjs",
  ".mts", ".php", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".svelte", ".toml", ".ts", ".tsx",
  ".vue", ".yaml", ".yml",
]);
const ROOT_FILES = new Set([
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "pyproject.toml", "go.mod", "go.sum",
  "Cargo.toml", "Cargo.lock", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "requirements.txt", "setup.py", "setup.cfg", "composer.json", "Gemfile", "mix.exs", "deno.json", "deno.jsonc",
  "Makefile", "makefile", "GNUmakefile", "Taskfile.yml", "Taskfile.yaml", "Dockerfile", "README", "README.md",
  "README.markdown", "README.rst", "tsconfig.json", "jsconfig.json", "vite.config.ts", "vite.config.js",
  "webpack.config.js", "webpack.config.ts", "rollup.config.js", "next.config.js", "next.config.mjs",
  "nuxt.config.ts", "vite.config.mjs", "playwright.config.ts", "playwright.config.js", "vitest.config.ts", "jest.config.js", ".gitlab-ci.yml", ".travis.yml", "AGENTS.md", "CONTRIBUTING.md", "DEVELOPMENT.md",
  "PROJECT_MEMORY.md", ".godmode.json",
]);
const SECRET_NAME = /(?:^|[._-])(?:env(?:\.|$)|secret|secrets|credential|credentials|token|tokens|password|passwd|auth|api[-_.]?key|access[-_.]?key|private[-_.]?key|id_rsa)(?:$|[._-])/iu;
const SECRET_NAME_EXACT = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|.*(?:private[-_.]?key|access[-_.]?token|api[-_.]?key|id_rsa).*)$/iu;
const MIGRATION_NAME = /(?:^|[._/-])migrat(?:e|ion)s?(?:$|[._/-])|(?:^|[._-])(?:up|down|upgrade|downgrade)(?:$|[._-])/iu;
const SUSPICIOUS_COMMAND_NAME = /(?:^|[._-])(?:trap|hook|payload|command|script)(?:$|[._-])/iu;
const COMMAND_LINE = /^(?:\s*)(?:(?:npm|pnpm|yarn|bun|node|deno|python(?:3)?|pytest|go|cargo|make|task|mvn|gradle|docker|npx)\b|\.\/?(?:scripts?|bin)\/|\$\s+)/iu;
const SECRET_CONTENT = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|passwd|secret|token)\s*[=:]\s*[^\s#]+)/iu;
const LIFECYCLE_SCRIPTS = new Set(["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"]);

function truncateUtf8(value: string, maximumBytes = DOCTOR_MAX_FIELD_BYTES): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(`${output}${character}`, "utf8") > maximumBytes) break;
    output += character;
  }
  return output;
}

function safeRelative(root: string, absolute: string): string | undefined {
  const value = relative(root, absolute);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || value.includes("\0")) return undefined;
  return value.split(sep).join("/");
}

function pathText(value: string): string {
  return truncateUtf8(value.split(sep).join("/"));
}

function sameFile(left: nodeFs.Stats, right: nodeFs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function makeFileSystem(options: DoctorOptions): DoctorFileSystem {
  const supplied = options.fs ?? options.fileSystem ?? options.filesystem ?? {};
  return {
    lstatSync: supplied.lstatSync ?? ((path) => nodeFs.lstatSync(path)),
    realpathSync: supplied.realpathSync ?? ((path) => nodeFs.realpathSync(path)),
    readdirSync: supplied.readdirSync ?? ((path) => nodeFs.readdirSync(path, { encoding: "utf8" })),
    openSync: supplied.openSync ?? ((path, flags) => nodeFs.openSync(path, flags)),
    fstatSync: supplied.fstatSync ?? ((fd) => nodeFs.fstatSync(fd)),
    readSync: supplied.readSync ?? ((fd, buffer, offset, length, position) => nodeFs.readSync(fd, buffer, offset, length, position)),
    closeSync: supplied.closeSync ?? ((fd) => nodeFs.closeSync(fd)),
  };
}

function newState(root: string, options: DoctorOptions, fs: DoctorFileSystem): DiscoveryState {
  return {
    root, fs, options, scannedEntries: 0, aggregateReadBytes: 0, truncated: false,
    truncationReasons: new Set(), blocked: false, projectTypes: [], surfaces: [], tests: [], commands: [],
    docsConfig: [], gaps: [], safetyFindings: [], proposals: [], files: [], contents: new Map(),
    observedDirectories: new Set(), observedFiles: new Set(),
  };
}

function trimPathList(paths: readonly string[], maximum = 8): string[] {
  return [...new Set(paths)].sort().slice(0, maximum).map(pathText);
}

function addSafety(
  state: DiscoveryState,
  category: string,
  path?: string,
  detail?: string,
  secret = false,
  basis: DoctorBasis = "observed",
  confidence: DoctorConfidence = "high",
): void {
  if (state.safetyFindings.length >= DOCTOR_MAX_SAFETY_FINDINGS) {
    state.truncated = true;
    state.truncationReasons.add("safety-findings");
    return;
  }
  const finding: DoctorFinding = {
    category: truncateUtf8(category, 256), basis, confidence,
    ...(secret ? {} : path ? { path: pathText(path) } : {}),
    ...(detail ? { detail: truncateUtf8(detail, 512) } : {}),
  };
  state.safetyFindings.push(finding);
}

function addGap(state: DiscoveryState, category: string, detail: string, confidence: DoctorConfidence = "medium"): void {
  if (state.gaps.length >= DOCTOR_MAX_GAPS) {
    state.truncated = true;
    state.truncationReasons.add("gaps");
    return;
  }
  state.gaps.push({ category: truncateUtf8(category, 256), detail: truncateUtf8(detail, 512), basis: "inferred", confidence });
}

function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name) || SECRET_NAME_EXACT.test(name);
}

function isMigrationPath(path: string): boolean {
  return MIGRATION_NAME.test(`/${path}/`);
}

function isInterestingFile(path: string, depth: number): boolean {
  const name = basename(path);
  if (ROOT_FILES.has(name)) return true;
  if (name === "AGENTS.md" || name.toUpperCase() === "AGENTS.MD") return true;
  if (depth > 0 && SOURCE_EXTENSIONS.has(extname(name).toLowerCase())) return true;
  if (/^(?:README|CHANGELOG|CONTRIBUTING|DEVELOPMENT|WORKFLOW|VALIDATION)(?:\.|$)/iu.test(name)) return true;
  return false;
}

function isAllowedDirectory(name: string, parentPath = ""): boolean {
  if (ALLOWED_DIRECTORIES.has(name) || /^(?:test|spec|src|app|lib|docs?|migrations?)(?:[-_.].*)?$/iu.test(name)) return true;
  // Once inside an allowlisted source/test/docs/config tree, project-specific
  // subdirectories are data worth bounded inspection.  At checkout root only
  // the explicit directory allowlist is admitted.
  const first = parentPath.split("/")[0] ?? "";
  return parentPath !== "" && ALLOWED_DIRECTORIES.has(first);
}

function isIgnoredDirectory(name: string): boolean {
  return SKIP_DIRECTORIES.has(name.toLowerCase());
}

function commandText(command: string): string {
  let result = command.replace(/\r/g, "").trim();
  // Keep command candidates useful while ensuring a discovered secret never
  // enters a report.  This is redaction, not an attempt to validate safety.
  result = result.replace(/(-----BEGIN [^-]*PRIVATE KEY-----)[\s\S]*?(-----END [^-]*PRIVATE KEY-----)/giu, "$1[REDACTED]$2");
  result = result.replace(/\bBearer\s+[^\s'"`]+/giu, "Bearer [REDACTED]");
  result = result.replace(/\b(?:token|password|passwd|secret|api[_-]?key|client[_-]?secret|authorization)\s*([=:])\s*[^\s;&|]+/giu, (_match, separator: string) => `${_match.slice(0, _match.indexOf(separator))}${separator}[REDACTED]`);
  return truncateUtf8(result, 1024);
}

function addCommand(state: DiscoveryState, command: string, sourcePath: string, kind: string): void {
  const sanitized = commandText(command);
  if (!sanitized || state.commands.length >= DOCTOR_MAX_COMMANDS) {
    if (state.commands.length >= DOCTOR_MAX_COMMANDS) {
      state.truncated = true;
      state.truncationReasons.add("commands");
    }
    return;
  }
  const duplicate = state.commands.some((item) => item.command === sanitized && item.sourcePath === sourcePath && item.kind === kind);
  if (duplicate) return;
  state.commands.push({
    command: sanitized, sourcePath: pathText(sourcePath), kind: truncateUtf8(commandText(kind), 128),
    requiresExplicitApproval: true, basis: "observed", confidence: "high",
  });
}

function addTest(state: DiscoveryState, path: string, kind: string): void {
  if (state.tests.some((item) => item.path === path)) return;
  if (state.tests.length >= DOCTOR_MAX_TESTS) {
    state.truncated = true;
    state.truncationReasons.add("tests");
    return;
  }
  state.tests.push({ path: pathText(path), kind: truncateUtf8(kind, 128), evidencePaths: [pathText(path)], basis: "observed", confidence: "high" });
}

function addDocsConfig(state: DiscoveryState, path: string, category: string): void {
  if (state.docsConfig.some((item) => item.path === path)) return;
  if (state.docsConfig.length >= DOCTOR_MAX_DOCS_CONFIG) {
    state.truncated = true;
    state.truncationReasons.add("docs-config");
    return;
  }
  state.docsConfig.push({ path: pathText(path), category: truncateUtf8(category, 128), evidencePaths: [pathText(path)], basis: "observed", confidence: "high" });
}

function addProjectType(state: DiscoveryState, type: string, paths: readonly string[], confidence: DoctorConfidence = "high"): void {
  const evidencePaths = trimPathList(paths);
  const existing = state.projectTypes.find((item) => item.type === type);
  if (existing) {
    existing.evidencePaths = trimPathList([...existing.evidencePaths, ...evidencePaths]);
    return;
  }
  if (state.projectTypes.length >= 64) {
    state.truncated = true;
    state.truncationReasons.add("project-types");
    return;
  }
  state.projectTypes.push({ type: truncateUtf8(type, 256), evidencePaths, basis: "observed", confidence });
}

function addSurface(state: DiscoveryState, surface: InterfaceSurface, paths: readonly string[], confidence: DoctorConfidence): void {
  const evidencePaths = trimPathList(paths);
  const existing = state.surfaces.find((item) => item.surface === surface);
  if (existing) {
    existing.evidencePaths = trimPathList([...existing.evidencePaths, ...evidencePaths]);
    if (existing.confidence === "low" && confidence !== "low") existing.confidence = confidence;
    return;
  }
  if (state.surfaces.length >= DOCTOR_MAX_SURFACES) {
    state.truncated = true;
    state.truncationReasons.add("surfaces");
    return;
  }
  state.surfaces.push({ surface, evidencePaths, basis: "inferred", confidence });
}

function boundedRead(state: DiscoveryState, file: ScannedFile): ReadResult | undefined {
  const remaining = DOCTOR_MAX_AGGREGATE_READ_BYTES - state.aggregateReadBytes;
  if (remaining <= 0) {
    state.truncated = true;
    state.truncationReasons.add("aggregate-read-bytes");
    addSafety(state, "aggregate-read-limit", file.path, "bounded aggregate read budget exhausted");
    return undefined;
  }

  let before: nodeFs.Stats;
  let canonical: string;
  let fd: number | undefined;
  try {
    before = state.fs.lstatSync(file.absolutePath);
    if (before.isSymbolicLink()) {
      addSafety(state, "symlink", file.path, "symbolic link was not followed");
      return undefined;
    }
    if (!before.isFile()) {
      addSafety(state, "non-regular-file", file.path, "only regular files are inspected");
      return undefined;
    }
    canonical = state.fs.realpathSync(file.absolutePath);
    if (safeRelative(state.root, canonical) === undefined) {
      addSafety(state, "path-escape", file.path, "canonical path is outside the selected root");
      return undefined;
    }
    if (before.size > DOCTOR_MAX_FILE_BYTES) {
      state.truncated = true;
      state.truncationReasons.add("file-size");
      addSafety(state, "oversize-file", file.path, "individual file exceeds the bounded read size");
      return undefined;
    }

    const readLimit = Math.min(DOCTOR_MAX_FILE_BYTES, remaining);
    // O_NOFOLLOW protects the final path component on platforms that provide
    // it.  The canonical/regular-file checks above protect traversal on the
    // supported POSIX host; a race becomes a finding rather than an authority.
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    fd = state.fs.openSync(file.absolutePath, fsConstants.O_RDONLY | noFollow);
    const opened = state.fs.fstatSync(fd);
    let openedCanonical: string;
    try { openedCanonical = state.fs.realpathSync(file.absolutePath); } catch {
      addSafety(state, "read-race", file.path, "path changed while opening the file");
      return undefined;
    }
    if (safeRelative(state.root, openedCanonical) === undefined) {
      addSafety(state, "path-escape", file.path, "opened path is outside the selected root");
      return undefined;
    }
    if (!opened.isFile() || !sameFile(before, opened)) {
      addSafety(state, "read-race", file.path, "file identity changed during inspection");
      return undefined;
    }
    if (opened.size > DOCTOR_MAX_FILE_BYTES) {
      state.truncated = true;
      state.truncationReasons.add("file-size");
      addSafety(state, "oversize-file", file.path, "file grew beyond the bounded read size");
      return undefined;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (total < readLimit) {
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, readLimit - total));
      const count = state.fs.readSync(fd, chunk, 0, chunk.byteLength, total);
      if (count <= 0) break;
      // Charge each successful read before any post-read identity check. A
      // racing file must not make its bytes available to the next file.
      // Node's readSync contract bounds count by the requested length; fail
      // closed if a test/host seam violates that contract rather than ever
      // allowing the aggregate budget to be exceeded.
      if (count > chunk.byteLength) {
        addSafety(state, "read-failure", file.path, "filesystem returned more bytes than requested");
        return undefined;
      }
      state.aggregateReadBytes += count;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    const after = state.fs.fstatSync(fd);
    if (!after.isFile() || !sameFile(opened, after) || after.size !== opened.size) {
      addSafety(state, "read-race", file.path, "file changed while it was being read");
      return undefined;
    }
    if (total >= readLimit && opened.size > total) {
      state.truncated = true;
      state.truncationReasons.add(remaining <= DOCTOR_MAX_FILE_BYTES ? "aggregate-read-bytes" : "file-size");
      addSafety(state, remaining <= DOCTOR_MAX_FILE_BYTES ? "aggregate-read-limit" : "oversize-file", file.path, "bounded text inspection stopped at its limit");
    }
    return { text: Buffer.concat(chunks).toString("utf8"), bytes: total };
  } catch {
    addSafety(state, "read-failure", file.path, "file could not be safely inspected");
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { state.fs.closeSync(fd); } catch { addSafety(state, "close-failure", file.path, "file descriptor could not be closed"); }
    }
  }
}

function parseJson(text: string, state: DiscoveryState, path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    addSafety(state, "malformed-manifest", path, "expected a JSON object");
  } catch {
    addSafety(state, "malformed-manifest", path, "bounded JSON parse failed");
  }
  return undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

function packageDependencyNames(pkg: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(stringRecord(pkg.dependencies)), ...Object.keys(stringRecord(pkg.devDependencies)), ...Object.keys(stringRecord(pkg.peerDependencies))])]
    .map((name) => name.toLowerCase()).sort();
}

function parsePackage(state: DiscoveryState, path: string, text: string): string[] {
  const pkg = parseJson(text, state, path);
  if (!pkg) return [];
  const scripts = stringRecord(pkg.scripts);
  for (const [name, command] of Object.entries(scripts).sort(([left], [right]) => left.localeCompare(right))) {
    addCommand(state, command, path, `package-script:${name}`);
    if (LIFECYCLE_SCRIPTS.has(name)) addSafety(state, "lifecycle-script", path, "package lifecycle data is inert and requires explicit approval");
  }
  const bin = pkg.bin;
  if (typeof bin === "string" || (bin && typeof bin === "object")) {
    addProjectType(state, "node-cli", [path], "medium");
    addSurface(state, "cli", [path], "medium");
  }
  if (pkg.exports !== undefined || typeof pkg.main === "string" || typeof pkg.module === "string") {
    addProjectType(state, "node-library", [path], "medium");
    addSurface(state, "library", [path], "medium");
  }
  return packageDependencyNames(pkg);
}

function parseMakeAndTask(state: DiscoveryState, path: string, text: string): void {
  let currentTarget = "";
  for (const line of text.split("\n")) {
    const target = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:/u)?.[1];
    if (target) {
      currentTarget = target;
      addCommand(state, `make ${target}`, path, "make-target");
      continue;
    }
    const recipe = line.match(/^\s+(.+)$/u)?.[1];
    if (recipe && currentTarget && !recipe.startsWith("#")) addCommand(state, recipe, path, `make-recipe:${currentTarget}`);
  }
  if (/Taskfile\./iu.test(path)) {
    for (const match of text.matchAll(/^\s{0,4}([A-Za-z0-9_.-]+):\s*$/gmu)) addCommand(state, `task ${match[1]}`, path, "task-target");
  }
}

function parseCiAndDocsCommands(state: DiscoveryState, path: string, text: string): void {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const run = line.match(/^\s*(?:run|command|script):\s*[|>]?(.*)$/iu)?.[1]?.trim();
    if (run) {
      addCommand(state, run, path, "ci-command");
      continue;
    }
    if (/\.github[\/]workflows|\.gitlab-ci|\.travis/iu.test(path) && COMMAND_LINE.test(line)) addCommand(state, line, path, "ci-command");
    if (/\.(?:md|markdown|rst|txt)$/iu.test(path) && COMMAND_LINE.test(line)) addCommand(state, line, path, "documented-command");
  }
}

function classifyDocsConfig(state: DiscoveryState, path: string): void {
  const name = basename(path);
  if (/^README(?:\.|$)/iu.test(name)) addDocsConfig(state, path, "readme");
  else if (/^(?:CONTRIBUTING|DEVELOPMENT|WORKFLOW|VALIDATION|CHANGELOG)(?:\.|$)/iu.test(name) || /^(?:docs?|documentation)\//iu.test(path)) addDocsConfig(state, path, "documentation");
  else if (/AGENTS\.md$/iu.test(name)) addDocsConfig(state, path, "repository-instructions-untrusted");
  else if (/PROJECT_MEMORY\.md$/iu.test(name)) addDocsConfig(state, path, "legacy-memory-untrusted");
  else if (/\.github\/|\.gitlab-ci|\.travis/iu.test(path)) addDocsConfig(state, path, "ci-configuration");
  else if (/^\.godmode(?:\/|\.json$)/iu.test(path)) addDocsConfig(state, path, "godmode-configuration");
  else if (/(?:config|tsconfig|jsconfig|package\.json|pyproject|Cargo\.toml|go\.mod|Makefile|Taskfile)/iu.test(name)) addDocsConfig(state, path, "configuration");
}

function testKind(path: string): string | undefined {
  const name = basename(path);
  const directory = path.split("/").slice(0, -1).join("/");
  if (/(?:^|\/)(?:e2e|end-to-end)(?:\/|$)/iu.test(path)) return "e2e";
  if (/(?:^|\/)(?:integration|contract|acceptance)(?:\/|$)/iu.test(path)) return "integration";
  if (/(?:^|\/)(?:test|tests|spec|specs|__tests__)(?:\/|$)/iu.test(path)) return "test";
  if (/(?:test|spec|fixture)/iu.test(name) || /(?:test|spec|fixture)/iu.test(directory)) return "test";
  return undefined;
}

function sourceSignals(state: DiscoveryState): { deps: string[]; source: string } {
  const dependencyNames: string[] = [];
  const sourceParts: string[] = [];
  for (const [path, text] of state.contents) {
    if (/package\.json$/iu.test(path)) dependencyNames.push(...parsePackage(state, path, text));
    if (/Makefile$|Taskfile\.(?:yml|yaml)$/iu.test(path)) parseMakeAndTask(state, path, text);
    parseCiAndDocsCommands(state, path, text);
    sourceParts.push(text.slice(0, DOCTOR_MAX_FIELD_BYTES));
  }
  return { deps: [...new Set(dependencyNames)], source: sourceParts.join("\n") };
}

function inferSurfaces(state: DiscoveryState, dependencies: readonly string[], source: string): void {
  const directories = [...state.observedDirectories];
  const files = [...state.observedFiles];
  const anyEvidence = [...new Set([...directories, ...files])].sort();
  const fallbackEvidence = (): string[] => anyEvidence.slice(0, 1);
  const evidence = (patterns: RegExp[]): string[] => [...new Set([...directories, ...files].filter((path) => patterns.some((pattern) => pattern.test(path))))].sort();
  const deps = new Set(dependencies);
  const has = (names: readonly string[]) => names.some((name) => deps.has(name));

  const browserEvidence = evidence([/(?:^|\/)(?:web|frontend|pages|components|public|static)(?:\/|$)/iu, /\.(?:html|jsx|tsx|vue|svelte)$/iu]);
  if (browserEvidence.length || has(["react", "react-dom", "vue", "svelte", "next", "nuxt", "@angular/core", "@playwright/test", "playwright"]) || /\b(?:browser|browser-flow|createRoot|document\.querySelector|<button|window\.location)\b/iu.test(source)) addSurface(state, "browser-ui", browserEvidence.length ? browserEvidence : fallbackEvidence(), has(["react", "react-dom", "vue", "svelte", "next", "nuxt", "@angular/core", "@playwright/test", "playwright"]) ? "high" : "medium");

  const apiEvidence = evidence([/(?:^|\/)(?:api|server|backend|routes|handlers|controllers)(?:\/|$)/iu]);
  if (apiEvidence.length || has(["express", "fastify", "koa", "hono", "elysia", "graphql", "apollo-server"]) || /\b(?:api|request\/response|app\.(?:get|post|put|delete|use)|router\.(?:get|post|put|delete)|listen\s*\()/iu.test(source)) addSurface(state, "api", apiEvidence.length ? apiEvidence : fallbackEvidence(), has(["express", "fastify", "koa", "hono", "graphql"]) ? "high" : "medium");

  const cliEvidence = evidence([/(?:^|\/)(?:bin|cli|cmd)(?:\/|$)/iu]);
  if (cliEvidence.length || has(["commander", "yargs", "oclif", "cac"]) || /\b(?:cli|executable invocation|process\.argv)\b/iu.test(source)) addSurface(state, "cli", cliEvidence.length ? cliEvidence : fallbackEvidence(), has(["commander", "yargs", "oclif", "cac"]) ? "high" : "medium");

  const tuiEvidence = evidence([/(?:^|\/)(?:tui|terminal|console)(?:\/|$)/iu]);
  if (tuiEvidence.length || has(["ink", "blessed", "neo-blessed", "inquirer", "@inquirer/prompts"]) || /\b(?:tui|terminal|pty|readline\.createInterface|process\.stdin|process\.stdout|crossterm)\b/iu.test(source)) addSurface(state, "tui", tuiEvidence.length ? tuiEvidence : fallbackEvidence(), has(["ink", "blessed", "inquirer"]) ? "high" : "medium");

  const libraryEvidence = evidence([/(?:^|\/)(?:lib|libs)(?:\/|$)/iu, /(?:^|\/)src\/index\.[^/]+$/iu]);
  if (libraryEvidence.length || has(["@types/node"]) && (state.observedFiles.has("package.json") || state.observedFiles.has("tsconfig.json")) || [...state.observedFiles].some((path) => /(?:^|\/)index\.[cm]?[jt]sx?$/iu.test(path))) addSurface(state, "library", libraryEvidence.length ? libraryEvidence : fallbackEvidence(), libraryEvidence.length ? "medium" : "low");

  const persistenceEvidence = evidence([/(?:^|\/)(?:db|database|data|migrations?|schema)(?:\/|$)/iu]);
  if (persistenceEvidence.length || has(["prisma", "typeorm", "sequelize", "drizzle-orm", "knex", "mongoose", "sqlite3", "pg", "mysql2"]) || /\b(?:persistence|SELECT|INSERT INTO|CREATE TABLE|migration|database)\b/iu.test(source)) addSurface(state, "persistence-migration", persistenceEvidence.length ? persistenceEvidence : fallbackEvidence(), has(["prisma", "typeorm", "sequelize", "drizzle-orm", "sqlite3", "pg", "mysql2"]) ? "high" : "medium");

  const buildEvidence = evidence([/(?:^|\/)(?:\.github|\.circleci|\.gitlab|config)(?:\/|$)/iu, /(?:^|\/)(?:package\.json|tsconfig\.json|pyproject\.toml|Cargo\.toml|go\.mod|Makefile|Taskfile[^/]*)$/iu]);
  if (buildEvidence.length) addSurface(state, "build-config", buildEvidence, "high");

  const docsEvidence = evidence([/(?:^|\/)(?:docs?|documentation)(?:\/|$)/iu, /(?:^|\/)README(?:\.|$)/iu]);
  if (docsEvidence.length) addSurface(state, "documentation", docsEvidence, "high");

  state.surfaces.sort((left, right) => INTERFACE_SURFACES.indexOf(left.surface) - INTERFACE_SURFACES.indexOf(right.surface));
}

function inferProjectTypes(state: DiscoveryState, dependencies: readonly string[]): void {
  const files = new Set(state.observedFiles);
  const packagePath = [...files].find((path) => /package\.json$/iu.test(path));
  if (packagePath) addProjectType(state, "javascript", [packagePath]);
  if (files.has("tsconfig.json") || [...files].some((path) => /\.tsx?$/iu.test(path))) addProjectType(state, "typescript", files.has("tsconfig.json") ? ["tsconfig.json"] : [...files].filter((path) => /\.tsx?$/iu.test(path)).slice(0, 8));
  if (files.has("pyproject.toml") || files.has("setup.py") || files.has("requirements.txt")) addProjectType(state, "python", [files.has("pyproject.toml") ? "pyproject.toml" : [...files].find((path) => /(?:setup\.py|requirements\.txt)$/iu.test(path)) ?? ""]);
  if (files.has("go.mod")) addProjectType(state, "go", ["go.mod"]);
  if (files.has("Cargo.toml")) addProjectType(state, "rust", ["Cargo.toml"]);
  if (files.has("composer.json")) addProjectType(state, "php", ["composer.json"]);
  if (files.has("Gemfile")) addProjectType(state, "ruby", ["Gemfile"]);
  if (files.has("mix.exs")) addProjectType(state, "elixir", ["mix.exs"]);
  if (files.has("deno.json") || files.has("deno.jsonc")) addProjectType(state, "deno", [files.has("deno.json") ? "deno.json" : "deno.jsonc"]);
  if (dependencies.some((dependency) => ["react", "react-dom", "vue", "svelte", "next", "nuxt", "@angular/core", "@playwright/test", "playwright"].includes(dependency))) addProjectType(state, "web-application", packagePath ? [packagePath] : [...files].sort().slice(0, 1), "medium");
  if (state.observedFiles.has("Dockerfile")) addProjectType(state, "containerized", ["Dockerfile"], "medium");
}

function addVerificationNeeds(state: DiscoveryState): DoctorVerificationNeed[] {
  return state.surfaces.map((surface) => ({
    surface: surface.surface,
    method: INTERFACE_METHOD_BY_SURFACE[surface.surface],
    reason: truncateUtf8(`A ${surface.surface} surface was inferred; verify it through its canonical interface method.`),
    basis: "proposed" as const,
    confidence: "medium" as const,
  }));
}

function inspectTree(state: DiscoveryState): void {
  const visit = (directory: { absolutePath: string; relativePath: string; depth: number }): void => {
    let names: string[];
    try {
      const directoryStat = state.fs.lstatSync(directory.absolutePath);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        addSafety(state, directoryStat.isSymbolicLink() ? "symlink" : "non-directory", directory.relativePath || undefined, "directory was not safely traversed");
        return;
      }
      const canonicalDirectory = state.fs.realpathSync(directory.absolutePath);
      if (canonicalDirectory !== state.root && safeRelative(state.root, canonicalDirectory) === undefined) {
        addSafety(state, "path-escape", directory.relativePath || undefined, "directory canonical path is outside the selected root");
        return;
      }
      names = [...state.fs.readdirSync(directory.absolutePath)].sort((left, right) => left.localeCompare(right));
    } catch {
      addSafety(state, "directory-read-failure", directory.relativePath || undefined, "directory could not be safely enumerated");
      if (!directory.relativePath) state.blocked = true;
      return;
    }
    for (const name of names) {
      if (state.scannedEntries >= DOCTOR_MAX_SCANNED_ENTRIES) {
        state.truncated = true;
        state.truncationReasons.add("scanned-entries");
        return;
      }
      state.scannedEntries += 1;
      if (!name || name === "." || name === ".." || name.includes("\0") || name.includes("/") || name.includes("\\")) {
        addSafety(state, "unsafe-entry-name", undefined, "directory entry name was not a safe single path component");
        continue;
      }
      const path = directory.relativePath ? `${directory.relativePath}/${name}` : name;
      const absolutePath = join(directory.absolutePath, name);
      let stat: nodeFs.Stats;
      try { stat = state.fs.lstatSync(absolutePath); } catch {
        addSafety(state, "lstat-failure", path, "entry could not be safely inspected");
        continue;
      }
      if (stat.isSymbolicLink()) {
        if (isSecretName(name)) addSafety(state, "secret-like-file", path, "secret-like path was not inspected", true);
        else addSafety(state, "symlink", path, "symbolic link was not followed");
        continue;
      }
      if (stat.isDirectory()) {
        if (isSecretName(name)) {
          addSafety(state, "secret-like-directory", path, "secret-like directory was not inspected", true);
          continue;
        }
        if (isIgnoredDirectory(name)) continue;
        state.observedDirectories.add(pathText(path));
        if (directory.depth >= DOCTOR_MAX_DEPTH) {
          state.truncated = true;
          state.truncationReasons.add("depth");
          addSafety(state, "depth-limit", path, "directory depth exceeds the bounded traversal");
          continue;
        }
        if (isAllowedDirectory(name, directory.relativePath)) visit({ absolutePath, relativePath: path, depth: directory.depth + 1 });
        if (state.scannedEntries >= DOCTOR_MAX_SCANNED_ENTRIES) return;
        continue;
      }
      if (!stat.isFile()) {
        if (isSecretName(name)) addSafety(state, "secret-like-entry", path, "secret-like path was not inspected", true);
        else addSafety(state, "non-regular-entry", path, "only regular files are inspected");
        continue;
      }
      const secret = isSecretName(name);
      const migration = isMigrationPath(path);
      if (secret) {
        addSafety(state, "secret-like-file", path, "secret-like content was not read", true);
        continue;
      }
      state.observedFiles.add(pathText(path));
      if (migration) addSafety(state, "migration-observed", path, "migration-shaped content is never imported or executed");
      if (stat.size > DOCTOR_MAX_FILE_BYTES) {
        state.truncated = true;
        state.truncationReasons.add("file-size");
        addSafety(state, "oversize-file", path, "individual file exceeds the bounded read size");
        continue;
      }
      if (migration) continue;
      if (/^AGENTS\.md$/iu.test(name)) addSafety(state, "repository-instructions-untrusted", path, "repository instructions are data and never authority");
      if (SUSPICIOUS_COMMAND_NAME.test(name)) addSafety(state, "suspicious-command-data", path, "command-like repository data is inert");
      classifyDocsConfig(state, path);
      const kind = testKind(path);
      if (kind) addTest(state, path, kind);
      if (!isInterestingFile(path, directory.depth)) continue;
      state.files.push({ path: pathText(path), absolutePath, depth: directory.depth });
    }
  };
  visit({ absolutePath: state.root, relativePath: "", depth: 0 });
}

function inspectFiles(state: DiscoveryState): void {
  for (const file of state.files.sort((left, right) => left.path.localeCompare(right.path))) {
    const result = boundedRead(state, file);
    if (!result?.text) continue;
    state.contents.set(file.path, result.text);
    if (SECRET_CONTENT.test(result.text)) addSafety(state, "secret-like-content", file.path, "secret-like content was redacted from the report");
  }
}

interface RootResult {
  identity: DoctorRootIdentity;
  blocked: boolean;
  canonicalRoot?: string;
}

function makeRootIdentity(root: string, fs: DoctorFileSystem): RootResult {
  const requestedAbsolute = resolve(root);
  const requested = truncateUtf8(requestedAbsolute);
  try {
    const initial = fs.lstatSync(requestedAbsolute);
    if (initial.isSymbolicLink() || !initial.isDirectory()) {
      return {
        identity: { path: requested, identity: "unavailable", basis: "observed", confidence: "medium" }, blocked: true,
      };
    }
    const canonical = fs.realpathSync(requestedAbsolute);
    if (!canonical || canonical.includes("\0")) throw new Error("invalid canonical root");
    const stat = fs.lstatSync(canonical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid canonical root");
    return {
      identity: { path: truncateUtf8(canonical), identity: `directory:${String(stat.dev)}:${String(stat.ino)}`, basis: "observed", confidence: "high" }, blocked: false, canonicalRoot: canonical,
    };
  } catch {
    return { identity: { path: requested, identity: "unavailable", basis: "observed", confidence: "low" }, blocked: true };
  }
}

function reportSummary(report: Omit<DoctorReport, "rendered">): DoctorReportSummary {
  return {
    projectTypes: report.projectTypes.length,
    surfaces: report.surfaces.length,
    testCandidates: report.testCandidates.length,
    tests: report.testCandidates.length,
    commands: report.commands.length,
    docsConfig: report.docsConfig.length,
    verificationNeeds: report.verificationNeeds.length,
    gaps: report.gaps.length,
    safetyFindings: report.safetyFindings.length,
    proposals: report.proposals.length,
  };
}

function reportBytes(payload: Omit<DoctorReport, "rendered">): number {
  const rendered = renderDoctorReport({ ...payload, rendered: "" } as DoctorReport);
  return Buffer.byteLength(JSON.stringify({ ...payload, rendered }), "utf8");
}

function compactRoot(root: DoctorRootIdentity, maximumBytes = 160): DoctorRootIdentity {
  return {
    path: truncateUtf8(root.path, maximumBytes),
    identity: truncateUtf8(root.identity, maximumBytes),
    basis: "observed",
    confidence: root.confidence,
  };
}

function compactFinding(finding: DoctorFinding, maximumBytes = 160): DoctorFinding {
  return {
    category: truncateUtf8(finding.category, maximumBytes),
    ...(finding.path ? { path: truncateUtf8(finding.path, maximumBytes) } : {}),
    ...(finding.detail ? { detail: truncateUtf8(finding.detail, maximumBytes) } : {}),
    basis: finding.basis,
    confidence: finding.confidence,
  };
}

function compactProjectType(item: DoctorProjectType): DoctorProjectType {
  return { ...item, type: truncateUtf8(item.type, 128), evidencePaths: item.evidencePaths.slice(0, 2).map((path) => truncateUtf8(path, 128)) };
}

function compactSurface(item: DoctorSurface): DoctorSurface {
  return { ...item, evidencePaths: item.evidencePaths.slice(0, 2).map((path) => truncateUtf8(path, 128)) };
}

function compactTest(item: DoctorTestCandidate): DoctorTestCandidate {
  return { ...item, path: truncateUtf8(item.path, 128), kind: truncateUtf8(item.kind, 96), evidencePaths: item.evidencePaths.slice(0, 1).map((path) => truncateUtf8(path, 128)) };
}

function compactCommand(item: DoctorCommandCandidate): DoctorCommandCandidate {
  return { ...item, command: truncateUtf8(item.command, 160), sourcePath: truncateUtf8(item.sourcePath, 128), kind: truncateUtf8(item.kind, 96) };
}

function compactDocsConfig(item: DoctorDocConfigItem): DoctorDocConfigItem {
  return { ...item, path: truncateUtf8(item.path, 128), category: truncateUtf8(item.category, 96), evidencePaths: item.evidencePaths.slice(0, 1).map((path) => truncateUtf8(path, 128)) };
}

function compactVerificationNeed(item: DoctorVerificationNeed): DoctorVerificationNeed {
  return { ...item, reason: truncateUtf8(item.reason, 160) };
}

function compactProposal(item: DoctorProposal): DoctorProposal {
  return { ...item, path: truncateUtf8(item.path, 128), rationale: truncateUtf8(item.rationale, 160) };
}

/** Security/race findings are retained before ordinary diagnostics when the
 * report object must be compacted. The final tie-breakers remain deterministic. */
function safetyPriority(finding: DoctorFinding): number {
  if (/^(?:path-escape|secret-like|read-race|aggregate-read|read-failure|symlink|checkout-race)/iu.test(finding.category)) return 0;
  if (/^(?:root-unavailable|non-regular|directory-read|lstat|close)/iu.test(finding.category)) return 1;
  return 2;
}

function compactSafetyFindings(findings: readonly DoctorFinding[], count: number): DoctorFinding[] {
  return [...findings]
    .sort((left, right) => safetyPriority(left) - safetyPriority(right)
      || left.category.localeCompare(right.category)
      || (left.path ?? "").localeCompare(right.path ?? ""))
    .slice(0, count)
    .map((finding) => compactFinding(finding));
}

function reportWithTruncation(
  report: Omit<DoctorReport, "rendered">,
  arrays: {
    projectTypes: DoctorProjectType[];
    surfaces: DoctorSurface[];
    testCandidates: DoctorTestCandidate[];
    commands: DoctorCommandCandidate[];
    docsConfig: DoctorDocConfigItem[];
    verificationNeeds: DoctorVerificationNeed[];
    gaps: DoctorFinding[];
    safetyFindings: DoctorFinding[];
    proposals: DoctorProposal[];
  },
  rootLimit = 160,
): Omit<DoctorReport, "rendered"> {
  const truncationReasons = [...new Set([...report.limits.truncationReasons, "report-bytes"])].sort();
  const root = compactRoot(report.root, rootLimit);
  return {
    ...report,
    root,
    rootIdentity: root,
    status: report.status === "blocked" ? "blocked" : "partial",
    limits: { ...report.limits, truncated: true, truncationReasons },
    ...arrays,
    // Keep the compatibility alias bounded with its canonical category.
    inertCommandCandidates: arrays.commands,
  };
}

function minimalReportPayload(report: Omit<DoctorReport, "rendered">): Omit<DoctorReport, "rendered"> {
  return reportWithTruncation(report, {
    projectTypes: [], surfaces: [], testCandidates: [], commands: [], docsConfig: [], verificationNeeds: [],
    gaps: report.gaps.slice(0, 1).map((finding) => compactFinding(finding, 96)),
    safetyFindings: compactSafetyFindings(report.safetyFindings, 1), proposals: [],
  }, 96);
}

function boundedReportPayload(report: Omit<DoctorReport, "rendered">): Omit<DoctorReport, "rendered"> {
  const complete = { ...report, summary: report.summary ?? reportSummary(report) };
  if (reportBytes(complete) <= DOCTOR_MAX_REPORT_BYTES) return complete;

  // Keep a small deterministic sample in each category and preserve exact
  // category counts through summary. The payload and its rendered field are
  // bounded together, rather than treating rendered as a separate budget.
  const compact = reportWithTruncation(complete, {
    projectTypes: complete.projectTypes.slice(0, 2).map(compactProjectType),
    surfaces: complete.surfaces.slice(0, 2).map(compactSurface),
    testCandidates: complete.testCandidates.slice(0, 2).map(compactTest),
    commands: complete.commands.slice(0, 2).map(compactCommand),
    docsConfig: complete.docsConfig.slice(0, 2).map(compactDocsConfig),
    verificationNeeds: complete.verificationNeeds.slice(0, 2).map(compactVerificationNeed),
    gaps: complete.gaps.slice(0, 2).map((finding) => compactFinding(finding)),
    safetyFindings: compactSafetyFindings(complete.safetyFindings, 2),
    proposals: complete.proposals.slice(0, 2).map(compactProposal),
  });
  if (reportBytes(compact) <= DOCTOR_MAX_REPORT_BYTES) return compact;
  return minimalReportPayload(complete);
}

function renderPayload(report: Omit<DoctorReport, "rendered">): Record<string, unknown> {
  const trim = <T>(items: readonly T[], count = 16): T[] => items.slice(0, count);
  return {
    schema: report.schema,
    schemaVersion: report.schemaVersion,
    version: report.version,
    root: report.root,
    status: report.status,
    readOnly: true,
    applyAvailable: false,
    limits: report.limits,
    summary: report.summary,
    projectTypes: trim(report.projectTypes),
    surfaces: trim(report.surfaces),
    testCandidates: trim(report.testCandidates),
    commands: trim(report.commands),
    docsConfig: trim(report.docsConfig),
    verificationNeeds: trim(report.verificationNeeds),
    gaps: trim(report.gaps),
    safetyFindings: trim(report.safetyFindings),
    proposals: trim(report.proposals),
    apply: "unavailable in Phase 5",
  };
}

function minimalRenderPayload(report: Omit<DoctorReport, "rendered">): Record<string, unknown> {
  return {
    schema: report.schema,
    schemaVersion: report.schemaVersion,
    version: report.version,
    root: compactRoot(report.root, 96),
    status: report.status,
    readOnly: true,
    applyAvailable: false,
    limits: report.limits,
    summary: report.summary,
    gaps: report.gaps.slice(0, 1).map((finding) => compactFinding(finding, 96)),
    safetyFindings: compactSafetyFindings(report.safetyFindings, 1),
    apply: "unavailable in Phase 5",
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const source = report as Omit<DoctorReport, "rendered">;
  const candidate = JSON.stringify(renderPayload(source), null, 2);
  if (Buffer.byteLength(candidate, "utf8") <= DOCTOR_MAX_REPORT_BYTES) return candidate;
  const compact = JSON.stringify(minimalRenderPayload(source), null, 2);
  if (Buffer.byteLength(compact, "utf8") <= DOCTOR_MAX_REPORT_BYTES) return compact;
  // All strings in this final shape are independently bounded. JSON is never
  // cut by bytes, so even a hostile injected filesystem cannot produce invalid
  // JSON from the public renderer.
  return JSON.stringify({
    schema: "godmode-doctor", schemaVersion: 1, version: 1,
    root: { path: "", identity: "unavailable", basis: "observed", confidence: "low" },
    status: source.status, readOnly: true, applyAvailable: false,
    limits: { maxReportBytes: DOCTOR_MAX_REPORT_BYTES, truncated: true, truncationReasons: ["report-bytes"] },
    summary: source.summary,
    safetyFindings: compactSafetyFindings(source.safetyFindings, 1),
    apply: "unavailable in Phase 5",
  });
}

function finalLimits(state: DiscoveryState): DoctorLimits {
  return {
    ...DOCTOR_LIMITS,
    scannedEntries: state.scannedEntries,
    aggregateReadBytes: state.aggregateReadBytes,
    truncated: state.truncated,
    truncationReasons: [...state.truncationReasons].sort(),
  };
}

/**
 * Run a deterministic static assessment.  All repository strings are treated
 * as data.  This function deliberately has no async, process, network, model,
 * ledger, or write path.
 */
export function runDoctor(root: string, options: DoctorOptions = {}): DoctorReport {
  const fs = makeFileSystem(options);
  const rootResult = makeRootIdentity(root, fs);
  const state = newState(rootResult.canonicalRoot ?? rootResult.identity.path, options, fs);
  state.blocked = rootResult.blocked;
  if (state.blocked) addSafety(state, "root-unavailable", state.root, "selected root is not a safe readable directory");

  if (!state.blocked) {
    inspectTree(state);
    inspectFiles(state);
    const { deps, source } = sourceSignals(state);
    inferProjectTypes(state, deps);
    inferSurfaces(state, deps, source);
  }

  const activeFaculty = typeof options.activeFaculty === "string" ? options.activeFaculty : undefined;
  if (activeFaculty) addSafety(state, "checkout-race-active-faculty", undefined, "an active faculty may race this read-only checkout snapshot", false, "inferred", "medium");
  if (state.tests.length === 0) addGap(state, "missing-tests", "No bounded test candidate was observed.");
  if (state.commands.length === 0) addGap(state, "missing-checks", "No inert project command candidate was observed.");
  if (state.surfaces.some((surface) => surface.surface === "persistence-migration") && !state.surfaces.some((surface) => surface.surface === "persistence-migration" && surface.evidencePaths.some((path) => /migrations?/iu.test(path)))) {
    addGap(state, "migration-verification", "Persistence or migration behavior needs disposable-storage verification.");
  }
  if (state.safetyFindings.length > 0) addGap(state, "safety-review", "Safety findings require Primary review before any explicit verification.", "high");

  const profilePath = ".godmode/validation-profile.json";
  const guidancePath = "docs/GODMODE_WORKFLOW.md";
  const hasProfile = state.observedFiles.has(profilePath) || state.observedFiles.has(".godmode.json");
  const hasGuidance = [...state.observedFiles].some((path) => /(?:^|\/)(?:GODMODE_WORKFLOW|WORKFLOW|VALIDATION)\.(?:md|markdown)$/iu.test(path));
  if (!hasProfile) {
    addGap(state, "missing-validation-profile", "A lightweight validation profile has not been observed.");
    if (state.proposals.length < DOCTOR_MAX_PROPOSALS) state.proposals.push({ path: profilePath, kind: "validation-profile", rationale: "Record explicit, user-approved interface checks without executing discovered commands.", basis: "proposed", confidence: "medium" });
  }
  if (!hasGuidance) {
    addGap(state, "missing-workflow-guidance", "Focused Godmode workflow guidance has not been observed.");
    if (state.proposals.length < DOCTOR_MAX_PROPOSALS) state.proposals.push({ path: guidancePath, kind: "workflow-guidance", rationale: "Document ownership, evidence methods, redaction, and approval boundaries in a focused file.", basis: "proposed", confidence: "low" });
  }

  state.projectTypes.sort((left, right) => left.type.localeCompare(right.type));
  state.tests.sort((left, right) => left.path.localeCompare(right.path));
  state.commands.sort((left, right) => `${left.sourcePath}\0${left.kind}\0${left.command}`.localeCompare(`${right.sourcePath}\0${right.kind}\0${right.command}`));
  state.docsConfig.sort((left, right) => left.path.localeCompare(right.path));
  state.gaps.sort((left, right) => `${left.category}\0${left.detail ?? ""}`.localeCompare(`${right.category}\0${right.detail ?? ""}`));
  state.safetyFindings.sort((left, right) => `${left.category}\0${left.path ?? ""}`.localeCompare(`${right.category}\0${right.path ?? ""}`));
  state.proposals.sort((left, right) => left.path.localeCompare(right.path));

  const status = state.blocked ? "blocked" : state.truncated || state.gaps.length > 0 || state.safetyFindings.length > 0 ? "partial" : "ready";
  const limits = finalLimits(state);
  const base = {
    schema: "godmode-doctor" as const,
    schemaVersion: 1 as const,
    version: 1 as const,
    root: rootResult.identity,
    rootIdentity: rootResult.identity,
    status: status as "ready" | "partial" | "blocked",
    readOnly: true as const,
    applyAvailable: false as const,
    limits,
    summary: {
      projectTypes: state.projectTypes.length,
      surfaces: state.surfaces.length,
      testCandidates: state.tests.length,
      tests: state.tests.length,
      commands: state.commands.length,
      docsConfig: state.docsConfig.length,
      verificationNeeds: state.surfaces.length,
      gaps: state.gaps.length,
      safetyFindings: state.safetyFindings.length,
      proposals: state.proposals.length,
    },
    projectTypes: state.projectTypes,
    surfaces: state.surfaces,
    testCandidates: state.tests,
    commands: state.commands,
    inertCommandCandidates: state.commands,
    docsConfig: state.docsConfig,
    verificationNeeds: addVerificationNeeds(state),
    gaps: state.gaps,
    safetyFindings: state.safetyFindings,
    proposals: state.proposals,
  };
  const payload = boundedReportPayload(base);
  const report = { ...payload, rendered: "" } as DoctorReport;
  report.rendered = renderDoctorReport(report);
  return report;
}

/** Compatibility spelling for call sites that prefer an assessment verb. */
export const assessDoctor = runDoctor;

/** A small explicit helper useful to host integrations that only need text. */
export function doctorText(root: string, options: DoctorOptions = {}): string {
  return runDoctor(root, options).rendered;
}
