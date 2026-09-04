import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(new URL("../../", import.meta.url).pathname);
const markdownFiles = [
  "README.md",
  "SPEC.md",
  "IMPLEMENTATION_PLAN.md",
  "docs/DOCTOR.md",
  "docs/EVIDENCE.md",
  "docs/STATE_AND_MEMORY.md",
  "docs/WORKFLOW.md",
];

test("local Markdown links resolve without network access", () => {
  for (const relative of markdownFiles) {
    const source = readFileSync(join(root, relative), "utf8");
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1]!;
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      const path = decodeURIComponent(target.split("#", 1)[0]!);
      assert.equal(existsSync(resolve(dirname(join(root, relative)), path)), true, `${relative} has broken link ${target}`);
    }
  }
});

test("post-Phase-1 baseline report records compatibility identity, validation, and historical timing", () => {
  const path = join(root, "docs/BASELINE.md");
  assert.equal(existsSync(path), true, "missing docs/BASELINE.md");
  const source = readFileSync(path, "utf8");
  for (const term of ["post-Phase-1", "c0eab03", "Node", "npm", "76", "same-user", "not an OS sandbox", "/godmode doctor", "not captured before mutation"]) {
    assert(source.includes(term), `baseline report missing: ${term}`);
  }
});
