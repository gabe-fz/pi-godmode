import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createGodmodeCommandHandler } from "../../src/extension-helpers.ts";
import { parseConfig } from "../../src/config.ts";
import { runDoctor } from "../../src/doctor.ts";
import type { GodmodeSnapshot } from "../../src/types.ts";

const root = new URL("../../", import.meta.url);
const file = (name: string): string => readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");

function snapshot(phase: GodmodeSnapshot["phase"] = "off"): GodmodeSnapshot {
  return { phase, delegation: "idle" };
}

test("controlled package consumer and build/config contract are available without network or process execution", async () => {
  const packageJson = JSON.parse(file("package.json")) as { files?: string[]; scripts?: Record<string, string> };
  assert(packageJson.files?.includes("docs/"));
  assert(packageJson.scripts?.typecheck);
  assert(packageJson.scripts?.test);
  // The published entry points to the extension source. This controlled
  // repository runner keeps the consumer assertion structural because its
  // Node type-stripper does not load TypeScript from node_modules; package
  // integration is covered by the host extension tests.
  assert.match(file("src/extension.ts"), /export default function godmodeExtension/);
  assert.equal(JSON.parse(file("tsconfig.json")).compilerOptions.noEmit, true);
});

test("disposable SessionManager persists and reopens a custom session entry", () => {
  const project = mkdtempSync(join(tmpdir(), "godmode-release-session-"));
  try {
    const manager = SessionManager.create(project, join(project, "sessions"));
    manager.appendCustomEntry("release-readiness", { observed: "local" });
    // SessionManager materializes a file when a normal session message is
    // appended; the custom entry is retained in that persisted branch.
    manager.appendMessage({
      role: "assistant", content: [], timestamp: Date.now(), api: "fixture", provider: "fixture", model: "fixture",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop",
    });
    const sessionFile = manager.getSessionFile();
    assert(sessionFile);
    const reopened = SessionManager.open(sessionFile);
    assert.equal(reopened.getBranch().some((entry) => entry.type === "custom" && entry.customType === "release-readiness"), true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("registered TUI handler and doctor/apply CLI-like interactions stay bounded and read-only", async () => {
  const project = mkdtempSync(join(tmpdir(), "godmode-release-command-"));
  try {
    const notifications: string[] = [];
    let phase: GodmodeSnapshot["phase"] = "off";
    const mode = {
      get snapshot(): GodmodeSnapshot { return snapshot(phase); },
      async enable() { phase = "active"; },
      async disable() { phase = "off"; },
    };
    const handler = createGodmodeCommandHandler({ mode, runDoctor, output: (message) => notifications.push(message) });
    const context = {
      mode: "tui" as const,
      cwd: project,
      hasUI: true,
      ui: { notify(message: string) { notifications.push(message); } },
      async waitForIdle() {},
      isProjectTrusted: () => true,
      isIdle: () => true,
    };
    await handler([], context);
    assert.equal(phase, "active");
    await handler("doctor", context);
    assert.match(notifications.at(-1) ?? "", /readOnly/);
    await handler("doctor --apply", context);
    assert.match(notifications.at(-1) ?? "", /applyAvailable|preview/);
    assert.equal(existsSync(join(project, ".godmode")), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("config parser remains exact for a controlled local release check", () => {
  const config = parseConfig({
    schemaVersion: 1,
    godmodePolicy: { allowedModels: [{ provider: "primary", model: "god" }], minimumThinking: "medium" },
    faculties: {
      eye: { provider: "eye", model: "model-eye", thinking: "low", timeoutMs: 60_000 },
      hand: { provider: "hand", model: "model-hand", thinking: "low", timeoutMs: 60_000 },
      scale: { provider: "scale", model: "model-scale", thinking: "low", timeoutMs: 60_000 },
    },
  });
  assert.equal(config.schemaVersion, 1);
});
