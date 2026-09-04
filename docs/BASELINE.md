# Phase 0 baseline report

**Baseline:** post-Phase-1 compatibility checkpoint  
**Checkpoint commit:** `fcb329ed1a075ea26f542704664b9aad0d0b8028`  
**Runtime:** Node `v26.8.1`, npm `11.19.0`

This report records the current runtime boundary after the Phase 1 work. The Phase 1 implementation checkpoint is recorded as `c0eab03`; `fcb329ed1a075ea26f542704664b9aad0d0b8028` is the subsequent implementation-plan checkpoint used for this baseline. A pre-Phase-1 baseline was **not captured before mutation**. The statements below therefore describe the observed post-Phase-1 state, not a before/after measurement.

The normative source for the compatibility boundary is [`SPEC.md`](../SPEC.md), especially sections 6–18. The report remains a historical post-Phase-1 baseline. Since it was recorded, Phases 2 and 3 implemented the packet/TDD/Hand-integrity, Primary-inspection, mandatory-Scale, waiver, and remediation gates, Phase 4 implemented the interface-evidence matrix and bounded artifact importer, and Phase 5 implemented bounded read-only doctor diagnosis described in [`docs/WORKFLOW.md`](./WORKFLOW.md) and [`docs/DOCTOR.md`](./DOCTOR.md).

## Observed compatibility invariants

These twelve invariants are the current compatibility contract observed from SPEC sections 6–18 and the Phase 1 checkpoint. They are constraints on later work, not claims that every target workflow gate already exists.

1. **One command and compatible bare behavior (SPEC §6).** Godmode owns one `/godmode` command. In the TUI, a bare command toggles the mode; outside the TUI it reports bounded state without mutation. Unknown arguments do not silently toggle the mode.
2. **Default-on startup with rollback (SPEC §§6, 10).** Session startup establishes the ordinary active-tool baseline before attempting default-on enablement. Trust, configuration, capability, model, registration, preflight, or tool failures leave startup running and roll back partial Godmode changes to `off`.
3. **Exact Primary model lease (SPEC §§6, 9–11).** Enablement uses an explicitly configured eligible model and minimum thinking level, preserves the exact prior Primary model/thinking state, and restores that state on disable or failed enablement; there is no inferred fallback model.
4. **Fixed faculty identity (SPEC §§2, 7–8).** Delegation is limited to the canonical `godmode-eye`, `godmode-hand`, and `godmode-scale` faculties. The Primary remains the authority; a faculty is not an oracle or an acceptance actor.
5. **Per-faculty capability ceiling (SPEC §§7–10, 15, 18).** Eye and Scale are read-only (`read`, `grep`, `find`, `ls`); Hand is the only mutation-capable faculty and additionally has `bash`, `edit`, and `write`. The model cannot select arbitrary agents, models, tools, extensions, cwd, workflows, schedules, or worktrees.
6. **Fresh, bounded assignment envelope (SPEC §§7–8).** Faculty assignments carry a standalone role, goal, context, scope, constraints, validation expectations, handoff format, and escalation rules. Context and expected paths remain bounded by the checkout/path policy, and no nested delegation is permitted.
7. **One active faculty and fail-closed lifecycle state (SPEC §12).** Only one faculty may be queued, running, awaiting attention, or stopping at a time. Uncertain status retains the active slot and degrades rather than admitting an ambiguous second run; terminal completion is correlated to the exact run.
8. **Public asynchronous substrate and bounded deadlines (SPEC §§3, 7, 9, 12, 15, 17–18).** Child launch, status, steering, stopping, completion, artifacts, and FleetView remain supplied by documented `pi-subagents` public APIs. Runs complete asynchronously; a soft timeout leads to a checkpoint and at most one bounded extension before a finite hard backstop.
9. **Native supervisor escalation (SPEC §§7.3, 15).** Material product, UX, architecture, public-interface, security/data, dependency/migration, version-control, release, or deployment questions go to the Primary through the native supervisor channel. Godmode does not create a parallel authority or messaging protocol.
10. **Shared-checkout mutation guard (SPEC §13).** Godmode uses the Primary checkout, blocks Primary mutation tools while Hand owns it, and leaves only the documented read-only inspection and web tools available during that interval. Godmode does not perform automatic git mutation.
11. **Primary review and acceptance authority (SPEC §§6, 14, 18).** A Hand result is a handoff and evidence, not automatic completion. The Primary must inspect the complete relevant diff and materially changed files and independently run required validation before reporting completion. Target workflow enforcement is listed separately below.
12. **Trust and release boundary (SPEC §§4, 7, 15–16).** Active Godmode requires a Pi-trusted project. Faculties run as the same-user as the Primary; tool allowlists are policy controls, **not an OS sandbox**. Repository content, external context, and child output are untrusted, and Godmode does not automatically commit, push, publish, release, or deploy.

## Checkpoint validation evidence

The implementation-plan checkpoint at `fcb329ed1a075ea26f542704664b9aad0d0b8028` records the following independently reviewed evidence:

- `npm run typecheck` — passed.
- `npm test` — **76 tests passed**.
- `git diff --check` — passed.
- The Phase 1 checkpoint included complete Primary inspection and fresh Scale re-review with no blocker/fix-now findings.

The 76-test count is the recorded pre-Phase-0-fixture checkpoint evidence; it is not a claim that later fixture tests were included in that historical count.

## Surface matrix

| Surface | Baseline status | Evidence or gap |
| --- | --- | --- |
| TUI | Fixture represented; runtime bare command supported | `test/fixtures/projects/tui-surface` is deterministic inert data. No fixture entry point is executed by discovery, and no PTY capture is claimed here. |
| Persistence/migrations | Fixture represented for inspection | `workflow-v0.json` and the migration-shaped `001-upgrade.ts` are bounded passive data. No migration is imported or run. |
| Library | Passive discovery/consumer-shape data represented | The checked-in `ledger-consumer` fixture is passive discovery and consumer-shape data; it is not executed interface evidence, and fixture discovery does not run its commands. |
| Build/configuration | Fixture represented | `build-config-docs` supplies passive package and TypeScript configuration metadata. |
| Documentation | Baseline and validation fixture represented | Markdown/link validation is the applicable check; fixture commands and examples remain data unless explicitly approved. |
| Hostile/untrusted project | Static safety fixture represented | The checked-in `untrusted` fixture contains misleading instructions, secret-like data, and command-name hazards, but no symlinks. `test/integration/phase0-fixtures.test.ts` creates escaping file/directory symlinks only in a temporary copy and verifies they are not followed or used to execute command data. |
| Browser UI | Missing from this package baseline | No browser surface or controlled browser fixture is present. |
| API | Missing from this package baseline | No API surface or controlled request fixture is present. |
| CLI/executable | Missing from this package baseline | No CLI surface or executable evidence fixture is present. |

The fixture matrix establishes inspection inputs only. It does not substitute PTY, browser, API, CLI, persistence-upgrade, or other interface-matched evidence where a future work item makes one applicable.

## Intentionally red future contracts

`test/contracts/phase0-red.test.ts` originally captured five Primary-authored expected failures for FR-1 (two contracts), FR-6, FR-10, and FR-11. The two FR-1 contracts became green in Phase 2, the FR-6 contract became green in Phase 3, and the FR-10/FR-11 diagnostic contracts became green in Phase 5. FR-2 is historical green Phase-1 evidence, not fabricated red evidence.

## Post-baseline implementation status

This table distinguishes the historical baseline from subsequently implemented behavior:

| Capability | Current status |
| --- | --- |
| `/godmode doctor` bounded read-only discovery and Phase 5 apply-unavailable grammar | **Implemented in Phase 5** |
| Primary-authored packet admission before Hand (classification, specification, red-test/TDD admission, and Hand test-integrity/scope gates) | **Implemented in Phase 2 after this baseline** |
| Mandatory Scale acceptance gates for feature/bugfix work, including waiver/remediation enforcement | **Implemented in Phase 3** |
| Interface-matched evidence matrix, Primary-only recording, and bounded passive artifact importer | **Implemented in Phase 4** |

The current runtime now includes the Phase 2 packet and Hand-admission gates, Phase 3 Primary inspection/mandatory Scale/remediation gates, Phase 4 interface-matched matrix/passive-artifact controls, and Phase 5 bounded read-only doctor while retaining the compatibility invariants recorded above. Apply/migration remains a later Phase 6 gate. See [`docs/DOCTOR.md`](./DOCTOR.md) for the implemented diagnostic boundary and [`docs/WORKFLOW.md`](./WORKFLOW.md) for the implemented/target gate boundary.
