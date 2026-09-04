# Godmode doctor (Phase 5)

> **Implementation status:** Phase 5 read-only diagnosis is implemented. Apply/migration remains unavailable until Phase 6. This document is normative for the bounded static assessment.

## Command shape and compatibility

Keep one user-facing slash command:

```text
/godmode                 # in TUI: toggle; outside TUI: bounded read-only state
/godmode doctor          # read-only readiness assessment
/godmode doctor --apply  # explicit Phase 5 read-only/unavailable response
```

Bare `/godmode` keeps its current TUI toggle semantics: off enables, active/degraded disables, and an active faculty follows the explicit stop-and-disable cleanup path. Outside the TUI it remains non-mutating. `doctor` is always read-only by default and must not toggle Godmode, change models/tools, create files, install packages, alter configuration, launch faculties, or run project commands.

`--apply` is parsed explicitly but reports **unavailable/read-only in Phase 5**. It performs no preview write, confirmation, migration, backup, replacement, or other project mutation. Phase 6 may add an explicit preview/confirmation flow; no Phase 5 path is allowed to create or alter files.

A future implementation may expose an equivalent non-TUI invocation through the host command surface, but it must preserve the same read-only default and explicit confirmation semantics. Unknown subcommands/options fail with usage guidance; they do not fall back to toggle behavior.

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

Doctor may propose a focused workflow/testing document at `docs/GODMODE_WORKFLOW.md` containing the project's goal/spec packet template, interface evidence map, and ownership/waiver policy. Phase 5 never creates or patches it. It must remain lightweight and must not become a duplicate memory diary. If a suitable existing profile or document is found, doctor reports it rather than proposing a competing file.

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

## Existing-project migration (Phase 6, not available in Phase 5)

Migration is additive and opt-in:

1. Run `/godmode doctor` and review the report; no files change.
2. Treat proposed profile/guidance paths as recommendations only; Phase 5 creates nothing.
3. Defer any apply preview, confirmation, migration, or scaffolding request until Phase 6.
4. When Phase 6 exists, it must confirm named operations, abort on conflicts/unexpected paths, and preserve recovery.
5. Keep generated files small and redacted; do not replace existing workflow docs silently.
6. Add work items gradually. For feature/bugfix items, start at classification/specification, author and observe red tests before Hand, collect interface-matched evidence, and require Scale before Primary acceptance.
7. Retain existing tests and commands as candidates until the Primary confirms their semantics. Do not mark a command as an evidence gate solely because doctor discovered it.
8. Record any TDD/Scale waiver narrowly with reason, approver, scope, and compensating evidence.

Legacy projects without a ledger use an ephemeral session ledger first; they do not need a heavyweight migration to begin. Legacy checklist/status files are imported as non-authoritative hints, reconciled against the canonical status model, and never treated as acceptance. Existing `PROJECT_MEMORY.md` or similar is not auto-injected; curate durable facts into focused docs only with preview and approval.

The current runtime/security contract remains unchanged: same-user faculty execution, trusted-project requirement for active Godmode, constrained tools/models, one active faculty, shared-checkout mutation guard, public pi-subagents APIs, no arbitrary child execution, and no automatic commits/releases/deployments. Phase 5 diagnosis is additive and read-only; apply/migration is explicitly deferred to Phase 6.

## Readiness result

Doctor ends with a bounded summary:

- status: `ready`, `partial`, or `blocked` (a partial result can include gaps and safety findings);
- observed project/surface map;
- existing checks and commands (not run by doctor);
- recommended profile/guidance changes and exact proposed paths;
- required human decisions and approvals;
- safety warnings and evidence/retention risks; and
- next action, without claiming that any recommendation has been implemented.
