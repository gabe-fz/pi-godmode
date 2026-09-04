import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const fixtures = new URL("../fixtures/projects/", import.meta.url);

function boundedInventory(root: string, maximumEntries = 64): string[] {
  const pending = [root];
  const result: string[] = [];
  while (pending.length > 0 && result.length < maximumEntries) {
    const directory = pending.shift()!;
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      result.push(path.slice(root.length + 1));
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) pending.push(path);
      if (result.length >= maximumEntries) break;
    }
  }
  return result;
}

test("Phase 0 fixture matrix represents only supported TUI, persistence, library, build/config, docs, and hostile surfaces", () => {
  for (const name of ["ledger-consumer", "tui-surface", "persistence-surface", "build-config-docs", "untrusted"]) {
    assert.equal(existsSync(new URL(`${name}/README.md`, fixtures)), true, `missing fixture: ${name}`);
  }
  assert.equal(existsSync(new URL("tui-surface/src/main.ts", fixtures)), true);
  assert.equal(existsSync(new URL("persistence-surface/data/workflow-v0.json", fixtures)), true);
  assert.equal(existsSync(new URL("persistence-surface/migrations/001-upgrade.ts", fixtures)), true);
  assert.equal(existsSync(new URL("build-config-docs/docs/validation.md", fixtures)), true);
});

test("hostile fixture inventory is bounded, does not follow escaping symlinks, and never executes command data", () => {
  const root = mkdtempSync(join(tmpdir(), "godmode-untrusted-fixture-"));
  const project = join(root, "project");
  const outside = join(root, "outside-secret.txt");
  const marker = join(root, "must-not-exist");
  writeFileSync(outside, "outside-secret");
  cpSync(new URL("untrusted/", fixtures), project, { recursive: true });
  symlinkSync(outside, join(project, "escape-file"));
  symlinkSync(root, join(project, "escape-directory"));
  writeFileSync(join(project, "trap-command.txt"), `touch ${marker}`);

  const inventory = boundedInventory(project, 16);
  assert(inventory.length <= 16);
  assert(inventory.includes("escape-file"));
  assert(inventory.includes("escape-directory"));
  assert.equal(inventory.some((entry) => entry.includes("outside-secret")), false);
  assert.equal(existsSync(marker), false);
});
