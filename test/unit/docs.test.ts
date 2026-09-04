import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(new URL("../../", import.meta.url).pathname);
const docs = readdirSync(join(root, "docs"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => `docs/${entry.name}`)
  .sort();
const markdownFiles = ["README.md", "SPEC.md", ...docs];

function slug(heading: string): string {
  return heading.trim().toLowerCase().replace(/<[^>]+>/gu, "").replace(/[^\p{Letter}\p{Number}\s-]/gu, "").replace(/\s+/gu, "-");
}

function shippedManifest(): Set<string> {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files?: string[] };
  assert(pkg.files?.includes("docs/"), "published package omits focused docs");
  const included = new Set<string>(["README.md", "SPEC.md", "LICENSE"]);
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else included.add(relative(root, path).split("\\").join("/"));
    }
  };
  for (const prefix of ["src", "docs"]) walk(join(root, prefix));
  return included;
}

test("local Markdown links, anchors, and shipped relative targets resolve without network access", () => {
  const shipped = shippedManifest();
  for (const file of markdownFiles) {
    const source = readFileSync(join(root, file), "utf8");
    const headings = new Set([...source.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) => slug(match[1]!)));
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1]!;
      if (/^(?:https?:|mailto:|#)/.test(target)) {
        if (target.startsWith("#")) assert(headings.has(target.slice(1)), `${file} has broken anchor ${target}`);
        continue;
      }
      const [rawPath, fragment] = target.split("#", 2);
      const path = decodeURIComponent(rawPath ?? "");
      const absolute = resolve(dirname(join(root, file)), path);
      assert.equal(existsSync(absolute), true, `${file} has broken link ${target}`);
      assert(shipped.has(relative(root, absolute).split("\\").join("/")), `${file} links to an omitted packed file ${target}`);
      if (fragment) {
        const linked = readFileSync(absolute, "utf8");
        const linkedHeadings = new Set([...linked.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((item) => slug(item[1]!)));
        assert(linkedHeadings.has(fragment), `${file} has broken linked anchor ${target}`);
      }
    }
  }
});

test("pure npm-pack-style manifest includes every shipped document without lifecycle execution", () => {
  const shipped = shippedManifest();
  for (const file of markdownFiles) assert(shipped.has(file), `packed manifest omits ${file}`);
  assert.equal(statSync(join(root, "docs")).isDirectory(), true);
  // This deliberately validates package.files instead of invoking npm pack:
  // lifecycle scripts, network, and publication are outside this check.
  assert.doesNotMatch(JSON.stringify([...shipped]), /IMPLEMENTATION_PLAN[.]md/);
});

test("documentation uses shipped terminology and preserves the compatibility baseline", () => {
  const all = markdownFiles.map((file) => readFileSync(join(root, file), "utf8")).join("\n");
  assert.doesNotMatch(all, /IMPLEMENTATION_PLAN[.]md|God-authored|God authors|target workflow/iu);
  assert.match(readFileSync(join(root, "docs/WORKFLOW.md"), "utf8"), /\bFR-1\b[\s\S]*\bFR-8\b/);
  assert.match(readFileSync(join(root, "docs/STATE_AND_MEMORY.md"), "utf8"), /\bFR-9\b/);
  assert.match(readFileSync(join(root, "docs/DOCTOR.md"), "utf8"), /\bFR-10\b[\s\S]*\bFR-12\b/);
  assert.match(readFileSync(join(root, "README.md"), "utf8"), /\bFR-13\b/);
  const baseline = readFileSync(join(root, "docs/BASELINE.md"), "utf8");
  for (const term of ["post-Phase-1", "c0eab03", "Node", "npm", "76", "same-user", "not an OS sandbox", "/godmode doctor", "not captured before mutation"]) {
    assert(baseline.includes(term), `baseline report missing: ${term}`);
  }
});
