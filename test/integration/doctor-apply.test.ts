import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerGodmodeCommand } from "../../src/extension-helpers.ts";
import { DOCTOR_APPLY_TOKEN_TTL_MS, DoctorApplyManager } from "../../src/doctor-apply.ts";
import { runDoctor } from "../../src/doctor.ts";

function context(root: string, trusted: boolean, active = false) {
  return {
    mode: "print" as const, cwd: root, hasUI: false,
    ui: { notify(_message?: string, _type?: string) {} }, isProjectTrusted: () => trusted, isIdle: () => true,
    async waitForIdle() {},
    active,
  };
}

test("registered apply handler is preview-first and trust/active guarded", async () => {
  const root = mkdtempSync(join(tmpdir(), "godmode-apply-integration-"));
  try {
    const manager = new DoctorApplyManager();
    const outputs: string[] = [];
    let handler: ((args: string, ctx: ReturnType<typeof context>) => Promise<void>) | undefined;
    const mode = {
      get snapshot() {
        return { phase: "active" as const, delegation: "idle" as const, ...(contextState.active ? {
          activeRun: { faculty: "hand" as const, agent: "godmode-hand" as const, title: "x", assignment: "x", phase: "running" as const, startedAt: 1 },
        } : {}) };
      },
      async enable() {}, async disable() {},
    };
    const contextState = { active: false };
    registerGodmodeCommand({ registerCommand(_name: string, command: { handler: typeof handler }) { handler = command.handler; } } as never, { mode: mode as never, doctorApplyManager: manager, output: (value) => outputs.push(value) });
    assert(handler);
    await handler("doctor --apply", context(root, false));
    assert.match(outputs.at(-1) ?? "", /not trusted/);
    await handler("doctor --apply", context(root, true));
    const preview = JSON.parse(outputs.at(-1) ?? "{}");
    assert.equal(preview.readOnly, true);
    assert.equal(preview.applyAvailable, true);
    assert.equal(existsSync(join(root, ".godmode/validation-profile.json")), false);
    assert.equal(existsSync(join(root, "docs/GODMODE_WORKFLOW.md")), false);
    contextState.active = true;
    await handler("doctor --apply", context(root, true));
    assert.match(outputs.at(-1) ?? "", /faculty hand is active/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("registered handler completes preview-confirm-create and replacement-recover in both delivery modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "godmode-apply-e2e-"));
  try {
    let now = 1000;
    const manager = new DoctorApplyManager({ now: () => now });
    const outputs: string[] = [];
    const notifications: string[] = [];
    let toggles = 0;
    let handler: ((args: string, ctx: ReturnType<typeof context>) => Promise<void>) | undefined;
    let active = false;
    registerGodmodeCommand({ registerCommand(_name: string, command: { handler: typeof handler }) { handler = command.handler; } } as never, {
      mode: {
        get snapshot() {
          return { phase: "active" as const, delegation: "idle" as const, ...(active ? {
            activeRun: { faculty: "hand" as const, agent: "godmode-hand", title: "x", assignment: "x", phase: "running" as const, startedAt: 1 },
          } : {}) };
        },
        async enable() { toggles += 1; }, async disable() { toggles += 1; },
      } as never,
      doctorApplyManager: manager,
      output: (value) => outputs.push(value),
    });
    assert(handler);
    const nonUi = () => context(root, true);
    const ui = () => ({ ...context(root, true), hasUI: true, ui: { notify(message: string) { notifications.push(message); } } });

    // Missing trust is denial; it must not become implicit trust or toggle.
    const noTrust = { ...nonUi() } as Record<string, unknown>;
    delete noTrust.isProjectTrusted;
    await handler("doctor --apply", noTrust as ReturnType<typeof context>);
    assert.match(outputs.at(-1) ?? "", /not trusted/);
    assert.equal(toggles, 0);

    // Non-UI preview then explicit confirmation creates both exact targets.
    await handler("doctor --apply", nonUi());
    const createPreview = JSON.parse(outputs.at(-1) ?? "{}");
    assert.equal(createPreview.readOnly, true);
    await handler(`doctor --apply --confirm ${createPreview.token}`, nonUi());
    assert.equal(JSON.parse(outputs.at(-1) ?? "{}").status, "applied");
    assert.equal(existsSync(join(root, ".godmode/validation-profile.json")), true);
    assert.equal(existsSync(join(root, "docs/GODMODE_WORKFLOW.md")), true);

    // Existing targets produce a conflict unless an exact replacement preview
    // is requested; UI delivery receives the same serialized result.
    await handler("doctor --apply", ui());
    const conflictPreview = JSON.parse(notifications.at(-1) ?? "{}");
    await handler(`doctor --apply --confirm ${conflictPreview.token}`, ui());
    assert.equal(JSON.parse(notifications.at(-1) ?? "{}").status, "conflict");
    await handler(`doctor --apply --confirm ${conflictPreview.token}`, ui());
    assert.match(notifications.at(-1) ?? "", /unknown|expired|already used/);
    await handler("doctor --apply --replace docs/GODMODE_WORKFLOW.md", nonUi());
    const expiredPreview = JSON.parse(outputs.at(-1) ?? "{}");
    now += DOCTOR_APPLY_TOKEN_TTL_MS;
    await handler(`doctor --apply --confirm ${expiredPreview.token}`, nonUi());
    assert.match(outputs.at(-1) ?? "", /unknown|expired|already used/);
    await handler("doctor --apply --replace docs/GODMODE_WORKFLOW.md", ui());
    const replacementPreview = JSON.parse(notifications.at(-1) ?? "{}");
    await handler(`doctor --apply --confirm ${replacementPreview.token}`, ui());
    const replacementResult = JSON.parse(notifications.at(-1) ?? "{}");
    assert.equal(replacementResult.status, "applied");
    assert(replacementResult.recoveryToken);
    await handler(`doctor --apply --recover ${replacementResult.recoveryToken}`, nonUi());
    assert.equal(JSON.parse(outputs.at(-1) ?? "{}").status, "recovered");

    // Invalid args, active faculty, false idle, and missing idle are all
    // non-mutating and do not call the legacy toggle path.
    await handler("doctor --apply --yes", nonUi());
    assert.match(outputs.at(-1) ?? "", /^Usage:/);
    active = true;
    await handler("doctor --apply", nonUi());
    assert.match(outputs.at(-1) ?? "", /faculty hand is active/);
    active = false;
    const falseIdle = { ...nonUi(), isIdle: () => false };
    await handler("doctor --apply --confirm badtoken", falseIdle);
    assert.match(outputs.at(-1) ?? "", /not affirmatively idle/);
    const missingIdle = { ...nonUi() } as Record<string, unknown>;
    delete missingIdle.isIdle;
    await handler("doctor --apply --confirm badtoken", missingIdle as ReturnType<typeof context>);
    assert.match(outputs.at(-1) ?? "", /not affirmatively idle/);
    await handler("doctor --apply --confirm badtoken", nonUi());
    assert.match(outputs.at(-1) ?? "", /malformed|unknown/);
    assert.equal(toggles, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
