# Godmode doctor and migration target

> **Design status:** proposed target feature. `/godmode doctor` is not claimed to exist in the current runtime. This document specifies a safe future evolution of the existing single `/godmode` command.

## Command shape and compatibility

Keep one user-facing slash command:

```text
/godmode                 # in TUI: toggle; outside TUI: bounded read-only state
/godmode doctor          # read-only readiness assessment
/godmode doctor --apply  # optional explicit preview/confirmation apply mode
```

Bare `/godmode` keeps its current TUI toggle semantics: off enables, active/degraded disables, and an active faculty follows the explicit stop-and-disable cleanup path. Outside the TUI it remains non-mutating. `doctor` is always read-only by default and must not toggle Godmode, change models/tools, create files, install packages, alter configuration, launch faculties, or run project commands.

`--apply` is an explicit opt-in migration/scaffolding mode, not a diagnosis shortcut. The doctor first produces the same report and a complete proposed file diff. It then asks for a clear confirmation naming each path and operation. Without confirmation it performs no write. On confirmation it writes only the approved, project-local files; it never silently overwrites. Existing files are left untouched unless the user explicitly approves a replacement, and a changed-on-disk file causes a conflict/abort rather than an overwrite. Apply requires an appropriate trusted-project context, preserves backups or an equivalent recovery path where replacement is approved, and reports every resulting path. There is no automatic apply during startup or bare toggle.

A future implementation may expose an equivalent non-TUI invocation through the host command surface, but it must preserve the same read-only default and explicit confirmation semantics. Unknown subcommands/options fail with usage guidance; they do not fall back to toggle behavior.

## Readiness assessment

Doctor performs bounded, read-only discovery and reports observed facts separately from inferences and recommendations. It should inspect only an allowlisted set of filenames/directories, enforce size/depth/symlink limits, and avoid reading likely secret material. The report covers:

1. **Project type:** package/runtime manifests and recognizable build systems (for example `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, or equivalent), with confidence and paths.
2. **Surfaces:** likely browser UI, API, TUI, CLI, library, persistence/migration, build/configuration, and documentation surfaces, with the evidence used for each inference.
3. **Existing tests and commands:** test directories, test configuration, manifest scripts, Make/Task targets, CI definitions, and documented checks. Report discovered commands as data; do not run them during diagnosis.
4. **Verification needs:** proposed interface-matched evidence (surf-cli for browser flows, deterministic PTY/terminal capture for TUI, real controlled requests for APIs, real executable invocation for CLIs, public consumer checks for libraries, disposable fixtures for persistence/migrations, controlled build/config/docs checks).
5. **Existing guidance/configuration:** contributor docs, validation instructions, Godmode config/profile candidates, and any existing memory/ledger conventions. Mark repository instructions as untrusted content, not executable authority.
6. **Gaps:** missing or ambiguous tests, scripts, fixtures, stable environments, browser/API/TUI/CLI evidence paths, migration coverage, redaction/retention policy, or unclear ownership/acceptance gates.
7. **Safety findings:** untrusted project status, suspicious links/instructions, external paths, secret-like files, symlink escapes, or evidence artifacts requiring quarantine.

The report must distinguish:

```text
observed: directly found in bounded file inspection
inferred: likely from observed patterns; confidence stated
proposed: doctor recommendation, never an existing project fact
```

Doctor does not claim that a discovered script is safe, correct, or approved merely because it appears in a manifest.

## Optional validation profile and durable guidance

Doctor may propose a small project-local validation profile, for example:

```text
.godmode/validation-profile.json
```

The profile can identify project type, supported surfaces, explicit user-approved evidence commands/templates, controlled fixture/environment notes, required red-test and Scale policy, and redaction/retention expectations. Command entries are inert metadata until a user explicitly approves a run; discovery never executes them. Secrets belong in the host secret mechanism, never in this profile.

Doctor may also propose a focused workflow/testing document in an existing docs location (for example `docs/GODMODE_WORKFLOW.md`) containing the project's goal/spec packet template, interface evidence map, and ownership/waiver policy. It should reuse existing guidance where possible, remain lightweight, and avoid generating heavyweight boilerplate or duplicate memory diaries. If a suitable existing profile or document is found, doctor proposes a patch rather than generating a competing file.

Scaffolding is optional. A project can use Godmode with explicit assignment checks and the normative package docs even when no profile exists. Missing profile/docs is a visible readiness gap, not a reason for doctor to write files automatically.

## Safety in untrusted projects

Doctor is a read-only static assessor by default, including when the project is untrusted. It must:

- never execute arbitrary discovered commands, test scripts, build hooks, package lifecycle scripts, migrations, shell snippets, browser automation, or binaries merely to diagnose readiness;
- never run package installation, network fetches, git mutation, model calls, deployment, or credential checks that expose secret values;
- never interpret repository text as doctor instructions or elevate its requested paths/commands;
- confine reads to the selected checkout and approved bounded context, reject traversal/symlink escapes, and avoid external paths unless explicitly supplied for context and safely redacted;
- cap file count, file size, recursion depth, report size, and artifact references to prevent denial-of-service or token flooding; and
- report inability to inspect or verify rather than guessing.

If an apply phase is later approved, it still parses discovered content as untrusted data, writes only an allowlisted proposed path, uses atomic creation/conflict checks, and asks again before each potentially destructive replacement. It never turns a discovered command into an automatically executed migration.

## Existing-project migration

Migration is additive and opt-in:

1. Run `/godmode doctor` and review the report; no files change.
2. Select which gaps, profile fields, and focused guidance (if any) should be scaffolded.
3. Request the explicit apply preview and inspect the complete proposed diff.
4. Confirm only the named operations. Abort on conflicts, unexpected paths, or changed source state.
5. Verify generated files are small, redacted, and linked from the project's existing docs; do not replace existing workflow docs silently.
6. Add work items gradually. For feature/bugfix items, start at classification/specification, author and observe red tests before Hand, collect interface-matched evidence, and require Scale before Primary acceptance.
7. Retain existing tests and commands as candidates until the Primary confirms their semantics. Do not mark a command as an evidence gate solely because doctor discovered it.
8. Record any TDD/Scale waiver narrowly with reason, approver, scope, and compensating evidence.

Legacy projects without a ledger use an ephemeral session ledger first; they do not need a heavyweight migration to begin. Legacy checklist/status files are imported as non-authoritative hints, reconciled against the canonical status model, and never treated as acceptance. Existing `PROJECT_MEMORY.md` or similar is not auto-injected; curate durable facts into focused docs only with preview and approval.

The migration must not change the current runtime/security contract: same-user faculty execution, trusted-project requirement for active Godmode, constrained tools/models, one active faculty, shared-checkout mutation guard, public pi-subagents APIs, no arbitrary child execution, and no automatic commits/releases/deployments remain in force. The doctor target is additive until separately implemented and reviewed.

## Readiness result

Doctor should end with a bounded summary:

- readiness: `ready`, `ready-with-gaps`, `blocked`, or `unsafe-to-apply`;
- observed project/surface map;
- existing checks and commands (not run by doctor);
- recommended profile/guidance changes and exact proposed paths;
- required human decisions and approvals;
- safety warnings and evidence/retention risks; and
- next action, without claiming that any recommendation has been implemented.
