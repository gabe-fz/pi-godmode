# Godmode doctor (FR-10, FR-11, FR-12)

> **Shipped behavior:** bounded read-only diagnosis and explicit previewed apply/recovery are implemented. This document is normative for the bounded static assessment and safe legacy reconciliation (FR-10), the one-command/apply grammar (FR-11), and the trust/security boundary (FR-12).

## Command shape and compatibility

Keep one user-facing slash command:

```text
/godmode                 # in TUI: toggle; outside TUI: bounded read-only state
/godmode doctor          # read-only readiness assessment
/godmode doctor --apply  # preview only; returns a token and proposed diff
/godmode doctor --apply --replace docs/GODMODE_WORKFLOW.md  # one exact replacement preview
/godmode doctor --apply --confirm <token>  # explicit trusted/idle apply
/godmode doctor --apply --recover <token>  # restore one approved replacement
```

Bare `/godmode` keeps its current TUI toggle semantics: off enables, active/degraded disables, and an active faculty follows the explicit stop-and-disable cleanup path. Outside the TUI it remains non-mutating. `doctor` is always read-only by default and must not toggle Godmode, change models/tools, create files, install packages, alter configuration, launch faculties, or run project commands.

`--apply` returns a read-only preview, cryptographic short-lived token, exact named operations, and a complete bounded proposed diff. It writes nothing. Direct preview callers may inspect untrusted projects because preview is read-only, but the registered command requires `context.isProjectTrusted?.() === true`; missing trust is denial. Only `--confirm <token>` can apply after an affirmative trusted-project proof, explicit host idle proof (`isIdle === true`), and explicit no-active-faculty proof (`activeFaculty: null`); missing or false proofs are denial, and an active faculty is refused. `--replace` is required for an existing target; confirmation never silently overwrites. Replacement results provide an expiring, process-local recovery token; an unproven recovery retains that same token and backup for retry until TTL. The read-only doctor render keeps `readOnly: true` and `applyAvailable: false`, and reports `apply: available only through explicit preview and confirmation`; effectful apply remains separately gated.

The shipped host command handler provides the supported non-TUI CLI-like invocation with the same read-only default and explicit confirmation semantics. Unknown subcommands/options fail with usage guidance; they do not fall back to toggle behavior.

## Readiness assessment

Doctor performs bounded, synchronous, read-only discovery and reports observed facts separately from inferences and recommendations. It inspects only an allowlisted set of filenames/directories, enforces depth 8, 256 entries, 256 KiB individual files, 2 MiB aggregate reads, 64 findings/candidates per category, and a 32 KiB UTF-8 bound on the complete serialized report object, including `rendered`. Oversized reports are valid deterministic JSON, mark `limits.truncationReasons` with `report-bytes`, retain category counts in `summary`, and preserve the highest-priority safety finding. Race-resistant `lstat`/`open(O_NOFOLLOW)`/`fstat` reads never follow symlinks or leave the canonical root; likely secret files are not read. The report covers:

1. **Project type:** package/runtime manifests and recognizable build systems (for example `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, or equivalent), with confidence and paths.
2. **Surfaces:** likely browser UI, API, TUI, CLI, library, persistence/migration, build/configuration, and documentation surfaces, with the evidence used for each inference.
3. **Existing tests and commands:** test directories, test configuration, manifest scripts, Make/Task targets, CI definitions, and documented checks. Report discovered commands as data; do not run them during diagnosis.
4. **Verification needs:** proposed interface-matched evidence mapped to `INTERFACE_METHOD_BY_SURFACE` (`real-browser-flow`, `deterministic-pty`, `controlled-request`, `executable-invocation`, `downstream-consumer`, `disposable-storage`, `supported-build-config-check`, and `rendered-doc-validation`).
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

Doctor may propose a focused workflow/testing document at `docs/GODMODE_WORKFLOW.md` containing the project's goal/spec packet template, interface evidence map, and ownership/waiver policy. Apply may create it only after explicit confirmation. It remains lightweight and must not become a duplicate memory diary. Existing targets are conflicts unless the exact target is separately previewed with `--replace`.

Scaffolding is optional. A project can use Godmode with explicit assignment checks and the normative package docs even when no profile exists. Missing profile/docs is a visible readiness gap, not a reason for doctor to write files automatically.

## Safety in untrusted projects

Doctor is a read-only static assessor by default, including when the project is untrusted. It must:

- never execute arbitrary discovered commands, test scripts, build hooks, package lifecycle scripts, migrations, shell snippets, browser automation, or binaries merely to diagnose readiness;
- never run package installation, network fetches, git mutation, model calls, deployment, or credential checks that expose secret values;
- never interpret repository text as doctor instructions or elevate its requested paths/commands;
- confine reads to the selected checkout and approved bounded context, reject traversal/symlink escapes, and avoid external paths unless explicitly supplied for context and safely redacted;
- cap file count, file size, recursion depth, report size, and artifact references to prevent denial-of-service or token flooding; and
- report inability to inspect or verify rather than guessing.

When apply is approved, it still parses discovered content as untrusted data, writes only an allowlisted proposed path, uses atomic creation/conflict checks, and never turns a discovered command into an automatically executed migration. A replacement is committed atomically only after its preview binding and backup are verified. If post-commit sync or verification fails, apply automatically attempts an atomic restore and deletes the backup only after restoration verifies. If rollback or cwd restoration cannot be proven, the result is an explicit error/partial result with accurate per-operation status, a bounded process-local recovery token, and the backup retained; a target proven installed before cwd restoration failure is listed as applied and later operations are stopped. All pinned operations use one synchronous process-global cwd guard shared by DoctorApplyManager instances; this registry is not crash-persistent. Active inspection, evidence, and recovery references are explicitly cleaned through lifecycle ownership, and expiry makes artifacts unusable. Startup/shutdown stale-candidate detection is bounded and read-only; crash leftovers defer to host OS temporary-file retention because automatic pathname deletion cannot be made race-safe with this runtime.

## Existing-project apply and legacy reconciliation

Migration is additive and opt-in:

1. Run `/godmode doctor` and review the report; no files change.
2. Use `/godmode doctor --apply` to inspect a bounded preview. The preview is read-only and includes candidate legacy hints, all named operations, a digest, and a one-time token.
3. Confirm only the displayed token. The registered command requires affirmative project trust and explicit host idle proof; all root/parent/target identities and legacy hint hashes must still match.
4. Existing targets require a separate exact `--replace` preview. Replacement creates an owner-only OS-temp backup and returns a process-local recovery token. A post-write failure first triggers automatic verified rollback; if that cannot be proven, the same bounded token and backup are retained and exposed. Recovery consumes the token and removes the backup only after target bytes and cwd restoration are fully proven. A recovery rename that completed before sync/verification/cwd failure can be safely finalized by retry; an unrelated generated-target mismatch is refused but retains the token until TTL.
5. Legacy `PROJECT_MEMORY.md`, `CHECKLIST.md`, `TODO.md`, `STATUS.md`, and `.godmode/checklist.json` are bounded, no-follow, untrusted hint sources. Their source files are never modified, commands remain inert, and no canonical phase/status/acceptance is imported.
6. Keep generated files small and redacted; do not replace existing workflow docs silently.
7. Add work items gradually. For feature/bugfix items, start at classification/specification, author and observe red tests before Hand, collect interface-matched evidence, and require Scale before Primary acceptance.
8. Retain existing tests and commands as candidates until the Primary confirms their semantics. Do not mark a command as an evidence gate solely because doctor discovered it.
9. Record any TDD/Scale waiver narrowly with reason, approver, scope, and compensating evidence.

Legacy projects without a ledger use an ephemeral session ledger first; they do not need a heavyweight migration to begin. Legacy checklist/status files are imported as non-authoritative hints, reconciled against the canonical status model, and never treated as acceptance. Hostile credential/private-key/bearer/cookie/signed-URL values and credential-like key names are filtered before generated profile/guidance; no raw secret or active content is copied. Existing `PROJECT_MEMORY.md` or similar is not auto-injected; curate durable facts into focused docs only with preview and approval. Apply/recovery handles and their backups are process-local to the extension instance; a restart does not provide crash-persistent recovery. Own-prefix inspection/evidence/recovery temp directories are inspected for stale candidates in bounded batches on startup/shutdown, but are never automatically deleted or renamed; crash leftovers defer to host OS temporary-file retention.

The current runtime/security contract remains unchanged: same-user faculty execution, trusted-project requirement for active Godmode, constrained tools/models, one active faculty, shared-checkout mutation guard, public pi-subagents APIs, no arbitrary child execution, and no automatic commits/releases/deployments. Apply writes only `.godmode/validation-profile.json` and `docs/GODMODE_WORKFLOW.md`; it never writes legacy memory/checklist/status files or executes discovered content.

## Readiness result

Doctor ends with a bounded summary:

- status: `ready`, `partial`, or `blocked` (a partial result can include gaps and safety findings);
- observed project/surface map;
- existing checks and commands (not run by doctor);
- recommended profile/guidance changes and exact proposed paths;
- required human decisions and approvals;
- safety warnings and evidence/retention risks; and
- next action, without claiming that any recommendation has been implemented.
