import assert from "node:assert/strict";
import { existsSync, linkSync as fsLinkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync as fsRenameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDoctor } from "../../src/doctor.ts";
import { DOCTOR_APPLY_TOKEN_TTL_MS, DoctorApplyManager } from "../../src/doctor-apply.ts";

function project(): string { return mkdtempSync(join(tmpdir(), "godmode-apply-unit-")); }
const effectful = { trusted: true, activeFaculty: null, isIdle: true } as const;

test("doctor apply preview is pure and confirmation creates only both allowlisted targets", () => {
  const root = project();
  try {
    writeFileSync(join(root, "CHECKLIST.md"), "- [ ] retain this candidate\nTOKEN=do-not-copy\n");
    const sourceBefore = readFileSync(join(root, "CHECKLIST.md"));
    const manager = new DoctorApplyManager();
    const preview = manager.createPreview(root, runDoctor(root));
    assert.equal(preview.readOnly, true);
    assert.equal(preview.operations.length, 2);
    assert(preview.legacyHints.some((hint) => hint.text === "retain this candidate"));
    assert.equal(preview.rendered.includes("do-not-copy"), false);
    assert(Buffer.byteLength(preview.rendered, "utf8") <= 32 * 1024);
    assert.deepEqual(readdirSync(root).sort(), ["CHECKLIST.md"]);
    const result = manager.apply(root, preview.token, effectful);
    assert.equal(result.status, "applied");
    assert(Buffer.byteLength(result.rendered, "utf8") <= 32 * 1024);
    assert.deepEqual(result.applied.sort(), [".godmode/validation-profile.json", "docs/GODMODE_WORKFLOW.md"]);
    assert.deepEqual(readFileSync(join(root, "CHECKLIST.md")), sourceBefore);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("existing target is a conflict and replacement has one-time recovery", () => {
  const root = project();
  try {
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/GODMODE_WORKFLOW.md"), "original\n");
    const manager = new DoctorApplyManager();
    const additive = manager.createPreview(root, runDoctor(root));
    const blocked = manager.apply(root, additive.token, effectful);
    assert.equal(blocked.status, "conflict");
    assert.equal(readFileSync(join(root, "docs/GODMODE_WORKFLOW.md"), "utf8"), "original\n");
    const replacement = manager.createPreview(root, runDoctor(root), { replacePath: "docs/GODMODE_WORKFLOW.md" });
    assert.equal(replacement.operations.length, 1);
    const applied = manager.apply(root, replacement.token, effectful);
    assert.equal(applied.status, "applied");
    assert(applied.recoveryToken);
    assert.equal(readFileSync(join(root, "docs/GODMODE_WORKFLOW.md"), "utf8").includes("Generated from bounded"), true);
    const recovered = manager.recover(root, applied.recoveryToken!, effectful);
    assert.equal(recovered.status, "recovered");
    assert.equal(readFileSync(join(root, "docs/GODMODE_WORKFLOW.md"), "utf8"), "original\n");
    assert.equal(manager.recover(root, applied.recoveryToken!, effectful).status, "refused");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("direct effectful APIs fail closed on missing or negative trust/idle while preview remains read-only", () => {
  const root = project();
  try {
    const manager = new DoctorApplyManager();
    const preview = manager.createPreview(root, runDoctor(root), { trusted: false, isIdle: false });
    assert.equal(manager.apply(root, preview.token).status, "denied");
    assert.equal(manager.apply(root, preview.token, { trusted: false, isIdle: true }).status, "denied");
    assert.equal(manager.apply(root, preview.token, { trusted: true, activeFaculty: undefined, isIdle: true }).status, "denied");
    assert.equal(manager.apply(root, preview.token, { trusted: true, activeFaculty: "hand", isIdle: true }).status, "denied");
    assert.equal(manager.apply(root, preview.token, { trusted: true, isIdle: false }).status, "denied");
    assert.equal(readdirSync(root).length, 0);
    assert.equal(manager.apply(root, preview.token, effectful).status, "applied");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("expired, malformed, replayed, and wrong-root tokens never write", () => {
  const root = project();
  const other = project();
  try {
    let now = 10_000;
    const manager = new DoctorApplyManager({ now: () => now });
    const preview = manager.createPreview(root, runDoctor(root));
    assert.equal(manager.apply(other, preview.token, effectful).status, "conflict");
    assert.equal(manager.apply(root, "not-a-token", effectful).status, "denied");
    now += DOCTOR_APPLY_TOKEN_TTL_MS;
    assert.equal(manager.apply(root, preview.token, effectful).status, "denied");
    const fresh = manager.createPreview(root, runDoctor(root));
    assert.equal(manager.apply(root, fresh.token, effectful).status, "applied");
    assert.equal(manager.apply(root, fresh.token, effectful).status, "denied");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

test("target and legacy hint changes after preview are conflicts with no writes", () => {
  const root = project();
  try {
    const manager = new DoctorApplyManager();
    const targetPreview = manager.createPreview(root, runDoctor(root));
    mkdirSync(join(root, ".godmode"));
    writeFileSync(join(root, ".godmode/validation-profile.json"), "race\n");
    const targetConflict = manager.apply(root, targetPreview.token, effectful);
    assert.equal(targetConflict.status, "conflict");
    assert.equal(readFileSync(join(root, ".godmode/validation-profile.json"), "utf8"), "race\n");

    rmSync(join(root, ".godmode/validation-profile.json"));
    const hint = join(root, "CHECKLIST.md");
    writeFileSync(hint, "- [ ] first\n");
    const hintPreview = manager.createPreview(root, runDoctor(root));
    writeFileSync(hint, "- [ ] changed\n");
    const hintConflict = manager.apply(root, hintPreview.token, effectful);
    assert.equal(hintConflict.status, "conflict");
    assert.equal(readFileSync(hint, "utf8"), "- [ ] changed\n");
    assert.equal(readdirSync(join(root, ".godmode")).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("parent and target symlinks are denied and legacy files stay byte-identical", () => {
  const root = project();
  const outside = project();
  try {
    writeFileSync(join(root, "CHECKLIST.md"), "- [ ] preserve\n");
    const before = readFileSync(join(root, "CHECKLIST.md"));
    symlinkSync(join(outside, "docs"), join(root, "docs"));
    const manager = new DoctorApplyManager();
    assert.throws(() => manager.createPreview(root, runDoctor(root)), /symlink|safe|parent/i);
    rmSync(join(root, "docs"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(outside, "target"), "outside\n");
    symlinkSync(join(outside, "target"), join(root, "docs/GODMODE_WORKFLOW.md"));
    assert.throws(() => manager.createPreview(root, runDoctor(root), { replacePath: "docs/GODMODE_WORKFLOW.md" }), /symbolic|symlink|target/i);
    assert.deepEqual(readFileSync(join(root, "CHECKLIST.md")), before);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("default multi-target failure reports every operation and leaves no temp artifact", () => {
  const root = project();
  try {
    const manager = new DoctorApplyManager();
    const preview = manager.createPreview(root, runDoctor(root));
    const result = manager.apply(root, preview.token, {
      ...effectful,
      beforeWrite(_operation, index) {
        if (index === 1) throw new Error("injected second-operation failure");
      },
    });
    assert.equal(result.status, "partial");
    assert.deepEqual(result.applied, [".godmode/validation-profile.json"]);
    assert.deepEqual(result.operations.map((entry) => entry.status), ["applied", "failed"]);
    assert.equal(result.failed.length, 1);
    assert.equal(existsSync(join(root, "docs")), false);
    assert.equal(readdirSync(root).some((name) => name.includes("godmode-write")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("creation race and replacement race refuse overwrite", () => {
  const root = project();
  try {
    const manager = new DoctorApplyManager();
    const createPreview = manager.createPreview(root, runDoctor(root));
    const createRace = manager.apply(root, createPreview.token, {
      ...effectful,
      beforeWrite(operation) {
        if (operation.path === ".godmode/validation-profile.json") {
          mkdirSync(join(root, ".godmode"));
          writeFileSync(join(root, ".godmode/validation-profile.json"), "raced\n");
        }
      },
    });
    assert.equal(createRace.status, "conflict");
    assert.equal(readFileSync(join(root, ".godmode/validation-profile.json"), "utf8"), "raced\n");

    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/GODMODE_WORKFLOW.md"), "before\n");
    const replacement = manager.createPreview(root, runDoctor(root), { replacePath: "docs/GODMODE_WORKFLOW.md" });
    const replacementRace = manager.apply(root, replacement.token, {
      ...effectful,
      beforeWrite() { writeFileSync(join(root, "docs/GODMODE_WORKFLOW.md"), "raced replacement\n"); },
    });
    assert.equal(replacementRace.status, "conflict");
    assert.equal(readFileSync(join(root, "docs/GODMODE_WORKFLOW.md"), "utf8"), "raced replacement\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("post-replacement failure restores the original, or retains a usable recovery token", () => {
  const root = project();
  try {
    mkdirSync(join(root, "docs"));
    const target = join(root, "docs/GODMODE_WORKFLOW.md");
    writeFileSync(target, "original\n");
    let syncCalls = 0;
    const filesystem = { fsyncSync() { syncCalls += 1; if (syncCalls === 3) throw new Error("injected post-write verification failure"); } };
    const manager = new DoctorApplyManager({ fs: filesystem });
    const preview = manager.createPreview(root, runDoctor(root), { replacePath: "docs/GODMODE_WORKFLOW.md" });
    const result = manager.apply(root, preview.token, effectful);
    assert.equal(result.status, "error");
    assert.equal(result.recoveryToken, undefined);
    assert.equal(readFileSync(target, "utf8"), "original\n");

    // A rename seam can report failure after it has already replaced the
    // target. Commit tracking must still restore the verified original.
    let renameCalls = 0;
    const renameFs = { renameSync(source: string, destination: string) {
      fsRenameSync(source, destination);
      renameCalls += 1;
      if (renameCalls === 1) throw new Error("injected post-rename failure");
    } };
    const renameManager = new DoctorApplyManager({ fs: renameFs });
    const renamePreview = renameManager.createPreview(root, runDoctor(root), { replacePath: "docs/GODMODE_WORKFLOW.md" });
    const renameResult = renameManager.apply(root, renamePreview.token, effectful);
    assert.equal(renameResult.status, "error");
    assert.equal(renameResult.recoveryToken, undefined);
    assert.equal(readFileSync(target, "utf8"), "original\n");

    let persistent = true;
    const recoveryFs = { fsyncSync() { syncCalls += 1; if (persistent && syncCalls >= 8) throw new Error("injected rollback failure"); } };
    const recoveryManager = new DoctorApplyManager({ fs: recoveryFs });
    writeFileSync(target, "original two\n");
    const second = recoveryManager.createPreview(root, runDoctor(root), { replacePath: "docs/GODMODE_WORKFLOW.md" });
    const secondResult = recoveryManager.apply(root, second.token, effectful);
    assert.equal(secondResult.status, "error");
    assert(secondResult.recoveryToken);
    persistent = false;
    const recovered = recoveryManager.recover(root, secondResult.recoveryToken!, effectful);
    assert.equal(recovered.status, "recovered");
    assert.equal(readFileSync(target, "utf8"), "original two\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pinned create refuses a parent swap without linking into the external target and restores cwd", () => {
  const root = project();
  const outside = project();
  const originalCwd = process.cwd();
  try {
    let swapped = false;
    const manager = new DoctorApplyManager({ fs: {
      linkSync(source: string, target: string) {
        if (!swapped && target === "GODMODE_WORKFLOW.md") {
          swapped = true;
          fsRenameSync(join(root, "docs"), join(root, "docs-original"));
          symlinkSync(outside, join(root, "docs"));
        }
        fsLinkSync(source, target);
      },
    } });
    const preview = manager.createPreview(root, runDoctor(root));
    const result = manager.apply(root, preview.token, effectful);
    assert.equal(swapped, true);
    assert.equal(result.status, "partial");
    assert.equal(existsSync(join(outside, "GODMODE_WORKFLOW.md")), false);
    assert.equal(existsSync(join(root, "docs", "GODMODE_WORKFLOW.md")), false);
    assert.equal(process.cwd(), originalCwd);
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("pinned replacement, rollback, and recovery swaps never redirect a rename outside the root", () => {
  const root = project();
  const outside = project();
  const originalCwd = process.cwd();
  try {
    mkdirSync(join(root, "docs"));
    const target = join(root, "docs/GODMODE_WORKFLOW.md");
    writeFileSync(target, "original\n");
    writeFileSync(join(outside, "GODMODE_WORKFLOW.md"), "external\n");

    let renameCalls = 0;
    let commitSwapped = false;
    const replaceManager = new DoctorApplyManager({ fs: {
      renameSync(source: string, destination: string) {
        renameCalls += 1;
        if (!commitSwapped && renameCalls === 1) {
          commitSwapped = true;
          fsRenameSync(join(root, "docs"), join(root, "docs-original"));
          symlinkSync(outside, join(root, "docs"));
        }
        fsRenameSync(source, destination);
      },
    } });
    const preview = replaceManager.createPreview(root, runDoctor(root), { replacePath: "docs/GODMODE_WORKFLOW.md" });
    const replaced = replaceManager.apply(root, preview.token, effectful);
    assert.equal(commitSwapped, true);
    assert.equal(replaced.status, "error");
    assert.equal(replaced.recoveryToken, undefined);
    assert.equal(readFileSync(join(root, "docs-original", "GODMODE_WORKFLOW.md"), "utf8"), "original\n");
    assert.equal(readFileSync(join(outside, "GODMODE_WORKFLOW.md"), "utf8"), "external\n");
    assert.equal(process.cwd(), originalCwd);

    // Force the post-commit check and automatic rollback fsyncs to fail, then
    // swap the parent during the retained recovery rename.
    rmSync(join(root, "docs"), { recursive: true, force: true });
    let recoveryFsyncCalls = 0;
    let recoveryRenameCalls = 0;
    const recoveryManager = new DoctorApplyManager({ fs: {
      fsyncSync() {
        // backup temp, replacement temp, post-commit sync, rollback temp,
        // rollback sync; only the latter two failures retain recovery.
        recoveryFsyncCalls += 1;
        if (recoveryFsyncCalls === 3 || recoveryFsyncCalls === 5) throw new Error("injected rollback failure");
      },
      renameSync(source: string, destination: string) {
        recoveryRenameCalls += 1;
        if (recoveryRenameCalls === 3) {
          fsRenameSync(join(root, "docs"), join(root, "docs-original-two"));
          symlinkSync(outside, join(root, "docs"));
        }
        fsRenameSync(source, destination);
      },
    } });
    // Recreate the expected original target after the first manager's parent
    // swap so this manager starts from a clean, bound replacement preview.
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/GODMODE_WORKFLOW.md"), "original two\n");
    const recoveryPreview = recoveryManager.createPreview(root, runDoctor(root), { replacePath: "docs/GODMODE_WORKFLOW.md" });
    const failed = recoveryManager.apply(root, recoveryPreview.token, effectful);
    assert.equal(failed.status, "error");
    assert(failed.recoveryToken);
    const recovered = recoveryManager.recover(root, failed.recoveryToken!, effectful);
    // Automatic rollback had already installed the original bytes before its
    // injected sync failure. Recovery safely proves those bytes idempotently;
    // it must not follow the now-swapped lexical parent.
    assert.equal(recovered.status, "recovered");
    assert.equal(readFileSync(join(outside, "GODMODE_WORKFLOW.md"), "utf8"), "external\n");
    assert.equal(process.cwd(), originalCwd);
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("cwd restoration failure reports proven apply and does not continue mutation", () => {
  const root = project();
  const originalCwd = process.cwd();
  let chdirCalls = 0;
  const beforeWrites: string[] = [];
  try {
    const manager = new DoctorApplyManager({ fs: {
      chdir(path: string) {
        chdirCalls += 1;
        if (chdirCalls === 2) throw new Error("injected cwd restoration failure");
        process.chdir(path);
      },
    } });
    const preview = manager.createPreview(root, runDoctor(root));
    const result = manager.apply(root, preview.token, { ...effectful, beforeWrite: (operation) => { beforeWrites.push(operation.path); } });
    assert.equal(result.status, "partial");
    assert.deepEqual(result.applied, [".godmode/validation-profile.json"]);
    assert.equal(result.failed.some((item) => item.path === ".godmode/validation-profile.json"), false);
    assert.equal(result.failed.some((item) => item.path === "docs/GODMODE_WORKFLOW.md" && /not attempted/i.test(item.reason)), true);
    assert.equal(result.operations.find((item) => item.path === ".godmode/validation-profile.json")?.status, "applied");
    assert.match(result.warnings.join(" "), /restoration|working directory/i);
    assert.equal(readFileSync(join(root, ".godmode/validation-profile.json"), "utf8"), preview.operations.find((item) => item.path === ".godmode/validation-profile.json")?.content);
    assert.equal(existsSync(join(root, "docs/GODMODE_WORKFLOW.md")), false);
    assert.deepEqual(beforeWrites, [".godmode/validation-profile.json"]);
    assert.equal(chdirCalls >= 2, true);
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("verified replacement remains applied when cwd restoration fails", () => {
  const root = project();
  const originalCwd = process.cwd();
  let failRestore = true;
  let restoreCalls = 0;
  try {
    mkdirSync(join(root, "docs"));
    const target = join(root, "docs/GODMODE_WORKFLOW.md");
    writeFileSync(target, "original\n");
    const manager = new DoctorApplyManager({ fs: {
      chdir(path: string) {
        if (path === originalCwd) {
          restoreCalls += 1;
          if (failRestore && restoreCalls === 2) throw new Error("injected replacement cwd restoration failure");
        }
        process.chdir(path);
      },
    } });
    const preview = manager.createPreview(root, runDoctor(root), { replacePath: "docs/GODMODE_WORKFLOW.md" });
    const result = manager.apply(root, preview.token, effectful);
    assert.equal(result.status, "partial");
    assert.deepEqual(result.applied, ["docs/GODMODE_WORKFLOW.md"]);
    assert.deepEqual(result.failed, []);
    assert.equal(result.operations[0]?.status, "applied");
    assert.match(result.warnings.join(" "), /restoration|working directory/i);
    assert(result.recoveryToken);
    assert.equal(readFileSync(target, "utf8"), preview.operations[0]?.content);
    failRestore = false;
    const recovered = manager.recover(root, result.recoveryToken!, effectful);
    assert.equal(recovered.status, "recovered");
    assert.equal(readFileSync(target, "utf8"), "original\n");
    assert.equal(process.cwd(), originalCwd);
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery retains the same token after a post-rename failure and retries idempotently", () => {
  const root = project();
  const originalCwd = process.cwd();
  try {
    mkdirSync(join(root, "docs"));
    const target = join(root, "docs/GODMODE_WORKFLOW.md");
    writeFileSync(target, "original\n");
    let failRecoveryRename = false;
    const manager = new DoctorApplyManager({ fs: {
      renameSync(source: string, destination: string) {
        fsRenameSync(source, destination);
        if (failRecoveryRename) throw new Error("injected after recovery rename");
      },
    } });
    const preview = manager.createPreview(root, runDoctor(root), { replacePath: "docs/GODMODE_WORKFLOW.md" });
    const applied = manager.apply(root, preview.token, effectful);
    assert(applied.recoveryToken);
    failRecoveryRename = true;
    const failed = manager.recover(root, applied.recoveryToken!, effectful);
    assert.equal(failed.status, "refused");
    assert.equal(failed.recoveryToken, applied.recoveryToken);
    assert.equal(readFileSync(target, "utf8"), "original\n");
    failRecoveryRename = false;
    const recovered = manager.recover(root, failed.recoveryToken!, effectful);
    assert.equal(recovered.status, "recovered");
    assert.equal(readFileSync(target, "utf8"), "original\n");
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery retains its token across cwd restoration failure and restores cwd on retry", () => {
  const root = project();
  const originalCwd = process.cwd();
  let failRestore = false;
  try {
    mkdirSync(join(root, "docs"));
    const target = join(root, "docs/GODMODE_WORKFLOW.md");
    writeFileSync(target, "original\n");
    const manager = new DoctorApplyManager({ fs: {
      chdir(path: string) {
        if (failRestore && path === originalCwd) throw new Error("injected recovery cwd restoration failure");
        process.chdir(path);
      },
    } });
    const preview = manager.createPreview(root, runDoctor(root), { replacePath: "docs/GODMODE_WORKFLOW.md" });
    const applied = manager.apply(root, preview.token, effectful);
    assert(applied.recoveryToken);
    failRestore = true;
    const failed = manager.recover(root, applied.recoveryToken!, effectful);
    assert.equal(failed.status, "refused");
    assert.equal(failed.recoveryToken, applied.recoveryToken);
    assert.equal(readFileSync(target, "utf8"), "original\n");
    failRestore = false;
    const recovered = manager.recover(root, failed.recoveryToken!, effectful);
    assert.equal(recovered.status, "recovered");
    assert.equal(readFileSync(target, "utf8"), "original\n");
    assert.equal(process.cwd(), originalCwd);
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("process-global cwd guard rejects a second manager before chdir or effects", () => {
  const root = project();
  try {
    const first = new DoctorApplyManager();
    let secondChdirCalls = 0;
    const second = new DoctorApplyManager({ fs: { chdir(path: string) { secondChdirCalls += 1; process.chdir(path); } } });
    const firstPreview = first.createPreview(root, runDoctor(root));
    const secondPreview = second.createPreview(root, runDoctor(root));
    const result = first.apply(root, firstPreview.token, {
      ...effectful,
      beforeWrite() {
        assert.throws(() => second.apply(root, secondPreview.token, effectful), /process|active|mutex/i);
      },
    });
    assert.equal(result.status, "applied");
    assert.equal(secondChdirCalls, 0);
    assert.equal(existsSync(join(root, ".godmode/validation-profile.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recovery refuses a generated target changed after replacement and mutex overlap is bounded", () => {
  const root = project();
  try {
    mkdirSync(join(root, "docs"));
    const target = join(root, "docs/GODMODE_WORKFLOW.md");
    writeFileSync(target, "original\n");
    const manager = new DoctorApplyManager();
    const preview = manager.createPreview(root, runDoctor(root), { replacePath: "docs/GODMODE_WORKFLOW.md" });
    const applied = manager.apply(root, preview.token, effectful);
    assert(applied.recoveryToken);
    writeFileSync(target, "changed after preview\n");
    const refused = manager.recover(root, applied.recoveryToken!, effectful);
    assert.equal(refused.status, "refused");
    assert.equal(refused.recoveryToken, applied.recoveryToken);
    assert.equal(manager.recover(root, refused.recoveryToken!, effectful).recoveryToken, applied.recoveryToken);
    assert.equal(readFileSync(target, "utf8"), "changed after preview\n");

    const create = manager.createPreview(root, runDoctor(root), { replacePath: "docs/GODMODE_WORKFLOW.md" });
    const overlap = manager.apply(root, create.token, {
      ...effectful,
      beforeWrite() { manager.apply(root, create.token, effectful); },
    });
    assert.equal(overlap.status, "error");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
