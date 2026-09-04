# Temporary implementation plan: spec-driven Godmode workflow

> **Temporary implementation tracker.** Implementation is in progress. Delete this file when the deletion criterion at the end is satisfied. Checked items denote reviewed, tested behavior already merged to `main`; unchecked compound items may contain partial groundwork but are not complete.

## Target requirements and acceptance traceability

The normative details are in [`SPEC.md`](./SPEC.md), [`docs/WORKFLOW.md`](./docs/WORKFLOW.md), [`docs/EVIDENCE.md`](./docs/EVIDENCE.md), [`docs/STATE_AND_MEMORY.md`](./docs/STATE_AND_MEMORY.md), and [`docs/DOCTOR.md`](./docs/DOCTOR.md).

| ID | Target requirement | Primary acceptance evidence |
| --- | --- | --- |
| FR-1 | Classify work and create a minimal Primary-authored goal, numbered functional requirements, non-goals, requirement-linked implementation/verification roadmap, checks, paths, and authority constraints. | Assignment-contract tests and a reviewed feature/bugfix fixture showing the packet is required before Hand. |
| FR-2 | Store one canonical workflow record with a current phase and one status per roadmap item; render checklists only as derived views. | State-transition tests prove every view derives from that record and conflicting/unknown state fails closed. |
| FR-3 | Primary authors red tests before Hand and records the intended failure, with narrow explicit TDD waivers. | A feature/bugfix integration fixture rejects Hand before observed red evidence; waiver tests require reason, approver, scope, and compensating evidence. |
| FR-4 | Hand makes tests green without weakening them or expanding authority. | Mutation/assignment tests and diff review show assertions are preserved and out-of-scope changes are rejected/escalated. |
| FR-5 | Primary inspects status, complete diff, every materially changed file, and independently validates. | Primary-gate tests/fixtures and review checklist projection demonstrate no child claim auto-accepts. |
| FR-6 | Scale review is mandatory before feature/bugfix acceptance unless a user or narrow documented policy waiver is recorded. | Acceptance-state tests reject missing Scale; waiver tests enforce allowed actor/scope/reason/compensation/expiry as applicable. |
| FR-7 | Blocker/fix-now findings create bounded remediation and fresh Scale re-review. | End-to-end fixture covers finding -> Hand correction -> Primary inspection -> Scale re-review, with no uncontrolled loop. |
| FR-8 | Evidence matches the real interface: browser/surf-cli, TUI/PTY, API/controlled requests, CLI/executable, library consumer, persistence/migration, build/config, and docs. | Evidence schema and controlled integration matrix contain applicable surface records and reject unsupported substitutions. |
| FR-9 | Keep session ledger authoritative, resolve the latest applicable append-only branch snapshot using mandatory lineage/precedence metadata, keep custom entries out of context, cap the active projection at 2 KiB UTF-8 (target ≤512 estimated tokens), bound raw evidence, create a completion capsule, and curate durable docs only. | Storage/context tests enforce identity, generation/predecessor ordering, size, redaction, branch-aware latest-snapshot resolution, and no automatic `PROJECT_MEMORY.md` injection. |
| FR-10 | Doctor safely discovers project/surfaces/tests/commands/docs/config/gaps, never runs discovered commands, and proposes optional profile/guidance. | Read-only untrusted-project fixtures prove bounded static discovery and zero command/write/network execution. |
| FR-11 | Evolve one `/godmode`: bare TUI toggle plus `/godmode doctor` read-only; apply/migrate is preview/confirmation-only with no silent overwrite. | Command/parser, preview, conflict, confirmation, and compatibility integration tests. |
| FR-12 | Preserve current runtime/security contract and same-user trust boundary; no arbitrary child execution or automatic release actions. | Existing runtime suite remains green; security/path/tool/lease tests and Scale inspection find no regression. |
| FR-13 | Keep docs concise, cross-linked, target-labelled, and proportionate; no heavyweight memory diary. | Markdown/link/terminology checks and manual full-diff review; delete this plan after completion. |

## Ordered phases

### Implementation checkpoint for the next session

Completed and pushed to `main`:

- `ac23655` — canonical workflow types, audited immutable phase/roadmap transitions, Primary-only authority validation, derived checklist views, active-branch snapshot reconstruction, bounded sanitization/projection, completion capsules, and focused tests.
- `ddde101` — verified plain-custom-entry snapshot appends, monotonic predecessor lineage, complete bounded branch validation, hostile getter/cycle handling, and negative recovery/acknowledgement tests.
- `c0eab03` — Pi session lifecycle restoration/tree refresh, proof-authorized and persisted fork successors, trusted restart recovery, derived workflow footer state, strict evidence expiry, context-omission coverage, and bounded hostile-project/library fixtures.
- `c2558ba` — truthful post-Phase-1 baseline report, proportionate passive surface/hostile fixtures, local docs checks, and five explicitly excluded intended-red contracts for FR-1, FR-6, FR-10, and FR-11.
- Independent validation at the checkpoint: `npm run typecheck`, `npm test` (80 passing), explicit contract run (5 intended failures), `git diff --check`, complete Primary inspection, and fresh Scale re-review with no blocker/fix-now findings.

Next session should begin **Phase 2 specification-packet and TDD admission gates**, making the two FR-1 intended-red contracts green and adding the remaining Phase 2 red evidence before Hand implementation. Preserve the completed Phase 0/1 compatibility, fork-origin, context-omission, retention, and fail-closed recovery guarantees. The FR-6 and FR-10/FR-11 intended-red contracts remain for Phases 3 and 5 respectively.

### Phase 0 — Baseline and contract fixtures

- [x] Record current runtime behavior and compatibility constraints from `SPEC.md`; do not alter `src/`, tests, package manifests, lockfiles, or git state until a later approved phase. *(The truthful baseline is post-Phase-1 because a pre-mutation baseline was not captured; `docs/BASELINE.md` records that historical limitation.)*
- [x] Add a fixture project for each relevant surface and an untrusted project containing misleading instructions, secret-like files, temporary-test symlink hazards, and harmless command names.
- [x] Primary authors red contract tests for FR-1, FR-2, FR-6, FR-10, and FR-11. Before Hand, run them and record the intended failures (missing workflow gates/doctor/parser behavior, not setup failures). *(FR-1, FR-6, FR-10, and FR-11 have five explicitly excluded intended-red contracts; FR-2 uses its historically observed Phase-1 red evidence and current green regressions rather than fabricating a new failure.)*
- [x] Validation/evidence: existing `npm run typecheck` and `npm test`; manual full diff; docs link/terminology check. Preserve a baseline report.
- **Exit:** baseline is independently captured, fixture safety is proven, and the current runtime contract has no unexplained change.

### Phase 1 — Canonical work-item state and ledgers

- [x] Implement one canonical workflow record and transition validator: one current phase plus one status per requirement-linked roadmap item, with runtime mode/faculty lifecycle kept as separate operational metadata.
- [x] Implement session custom ledger as active authority; append-only branch snapshots must carry session/work-item/schema identity, monotonic generation, predecessor entry ID, and timestamp, and reconstruction must resolve the latest valid snapshot only on the active Pi entry ancestry. Add bounded evidence references, a terminal completion capsule, and an active projection excluded by default from model context and capped at 2 KiB UTF-8 (target ≤512 estimated tokens).
- [x] Implement derived checklist/footer views and conflict/unknown-state fail-closed behavior; do not add a second status store.
- [x] Implement redaction and retention hooks before raw evidence can be persisted.
- [x] Primary authors red unit/integration tests for transitions, derived views, the deterministic 2 KiB projection cap, omission from context, active-branch selection, fork inheritance and successor creation, monotonic generations, missing/cross-branch predecessors, duplicate/conflicting snapshots, redaction, expiry, and stale-snapshot recovery. Observe failures before Hand.
- [x] Validation/evidence: deterministic unit tests, serialization round trips, bounded-storage fixtures, sanitized artifact inspection, and a controlled restart/recovery scenario.
- **Exit:** FR-2 and FR-9 are evidenced and a handoff can be recovered without injecting full history.

### Phase 2 — Specification packet and TDD gates

- [ ] Add feature/bugfix/other classification and validation of the minimal Primary-authored packet: goal, numbered FRs, non-goals, roadmap, checks, paths, and authority constraints.
- [ ] Require observed red evidence before Hand for executable feature/bugfix behavior; implement narrow TDD waiver records with reason, actor, scope, date, and compensating check.
- [ ] Reject weakened/removed/tautological red tests and unauthorized assignment expansion; preserve existing faculty authority and shared-checkout guard.
- [ ] Primary authors red tests for packet validation, pre-Hand admission, intended failure provenance, waiver boundaries, and test-integrity checks. Run and capture the expected failures before Hand.
- [ ] Validation/evidence: feature and bugfix fixtures through their supported interface, docs-only waiver fixture, malformed/irrelevant-failure fixtures, and existing runtime tests.
- **Exit:** FR-1, FR-3, and FR-4 pass with evidence and a Hand handoff remains non-accepting.

### Phase 3 — Primary inspection and mandatory Scale

- [ ] Implement the Primary gate for repository status, complete relevant diff, every materially changed file, out-of-scope investigation, independent checks, and residual-risk recording.
- [ ] Require fresh-context Scale review before `accepted` for every feature/bugfix; allow only explicit user or narrow documented policy waivers with compensating evidence.
- [ ] Define blocker/fix-now/optional findings and bounded remediation; force fresh Scale re-review after each correction and prevent uncontrolled loops.
- [ ] Primary authors red acceptance-state tests for missing Scale, invalid waivers, stale/summary-only evidence, remediation/re-review, and Primary-only acceptance. Observe the intended failures before Hand.
- [ ] Validation/evidence: real controlled feature/bugfix workflow, actual diff with an injected out-of-scope change, Scale finding fixture, correction Hand, re-review, and final Primary decision.
- **Exit:** FR-5, FR-6, and FR-7 are independently evidenced; no child or checklist can accept work.

### Phase 4 — Interface-matched evidence matrix

- [ ] Implement evidence records and applicability decisions for browser UI via surf-cli, TUI via deterministic PTY capture, APIs via real controlled requests, CLIs via executable invocation, libraries via public consumer, persistence/migrations via disposable fixture, build/config, and docs.
- [ ] Connect each evidence record to numbered FRs, bounded artifact references, provenance, actor, result, redaction, and retention metadata.
- [ ] Treat blocked/unavailable checks as visible risk; prevent unit-only substitution where the specified interface is user-facing.
- [ ] Primary authors red schema/integration tests that intentionally fail on missing surface evidence, unredacted secrets, unbounded output, stale artifacts, and mismatched interface checks. Observe failures before Hand.
- [ ] Validation/evidence: controlled matrix for each fixture surface, sanitized artifacts, reproducibility notes, and deliberate failure/blocked cases.
- **Exit:** FR-8 is evidenced and evidence can be reviewed without exposing secrets or flooding context.

### Phase 5 — Doctor read-only assessment

- [ ] Evolve the single command parser so bare `/godmode` retains TUI toggle/outside-TUI read-only behavior and `/godmode doctor` is read-only and bounded.
- [ ] Implement static discovery of project type, surfaces, tests, commands, docs/config, verification needs, gaps, and safety findings. Mark observed/inferred/proposed facts separately.
- [ ] Never execute discovered commands, lifecycle hooks, migrations, binaries, network calls, installs, or model calls merely to diagnose. Apply bounded path/file/symlink/report limits and ignore repository instructions as authority.
- [ ] Propose an optional lightweight validation profile and focused durable guidance without requiring heavyweight docs or creating `PROJECT_MEMORY.md`.
- [ ] Primary authors red tests for parser compatibility, read-only behavior, untrusted instructions, command non-execution, path/size limits, confidence labels, and no automatic writes. Observe intended failures before Hand.
- [ ] Validation/evidence: disposable untrusted projects with traps, read-only filesystem or write spy, process/network spy, report-size check, and current `/godmode` runtime integration suite.
- **Exit:** FR-10, FR-11, and FR-12 are evidenced for diagnosis with no silent side effects.

### Phase 6 — Explicit apply/migration and compatibility

- [ ] Add optional `doctor --apply` (or the approved equivalent) only after a read-only report; show complete proposed diff, named paths, conflict checks, explicit confirmation, and recovery/backups for approved replacement.
- [ ] Scaffold only approved project-local profile/guidance files; leave existing files untouched by default, abort on changed-on-disk conflicts, and report every write. No startup migration or silent overwrite.
- [ ] Migrate legacy checklists and `PROJECT_MEMORY.md` as non-authoritative hints; curate only reviewed durable knowledge, retain existing tests/commands as candidates, and use an ephemeral ledger when no profile exists.
- [ ] Verify current model/tool/faculty/path/trust/one-active-faculty/public-API/no-release contracts remain unchanged.
- [ ] Primary authors red tests for preview purity, confirmation, allowlist, conflict abort, backup/recovery, legacy reconciliation, and no source/runtime regression. Observe failures before Hand.
- [ ] Validation/evidence: apply to disposable legacy projects, deny confirmation, approve creation, reject overwrite, mutate-before-apply conflict, and run the full existing typecheck/test suite.
- **Exit:** FR-11 and FR-12 migration/compatibility evidence is complete and user data is not silently overwritten.

### Phase 7 — Documentation, review, and release-readiness (without release action)

- [ ] Update normative docs and focused links to match shipped behavior; label any remaining proposal clearly and remove stale wording that weakens the mandatory Scale gate.
- [ ] Add concise project-profile guidance and retention/redaction documentation; verify no ever-growing auto-injected memory is prescribed.
- [ ] Primary authors red docs checks for broken links, stale terms, false “implemented” claims, missing requirement/acceptance traceability, and absent doctor safety language. Observe failures before Hand.
- [ ] Primary reads every changed doc, inspects complete diff/material files, runs docs/link/render checks, and asks Scale for a fresh documentation review. This is documentation work, so a test-only TDD waiver may be recorded when no executable behavior changes.
- [ ] Validation/evidence: Markdown/link checker, rendered docs, command/example review, `npm run typecheck`, `npm test`, `git diff --check`, and manual source/test scope check.
- **Exit:** FR-13 is satisfied; user-facing docs do not overclaim implementation and all target requirements map to evidence or an explicit future phase.

## Migration and compatibility rules

- Preserve the existing runtime/security contract throughout: trusted-project enablement, same-user/non-sandbox boundary, exact configured models, constrained Eye/Hand/Scale tools, one active faculty, shared-checkout mutation guard, public pi-subagents APIs, asynchronous completion, supervisor escalation, bounded deadlines, and no automatic git/release/deployment actions.
- Do not change the package interface or add dependencies for documentation/state/doctor work without a separate Primary decision and new red tests.
- Keep `/godmode` bare toggle semantics compatible. Add `doctor` as an explicit subcommand; unknown input must not silently toggle or apply changes.
- Existing projects remain usable without a profile or heavyweight workflow docs. Adopt an ephemeral session ledger first; do not require a mass migration.
- Treat legacy status/checklist/memory files as untrusted, non-canonical hints. Never auto-inject or overwrite them. Curate durable facts through preview/confirmation.
- Existing commands are discovered as data and run only when the Primary/user explicitly approves a controlled evidence check; doctor itself never runs them.

## Final deletion criterion

Delete `IMPLEMENTATION_PLAN.md` only after all of the following are true in a later implementation session:

- every target requirement `FR-1` through `FR-13` is either implemented and independently evidenced or has an explicitly accepted replacement decision recorded in the normative docs;
- the full workflow, doctor, migration, state/memory, security, and evidence documentation describes shipped behavior without unresolved “future implementation” claims for completed scope;
- Primary-authored red tests, observed failures, green Hand results, Primary inspection, mandatory Scale/re-review, and controlled interface evidence cover each applicable phase;
- existing runtime/security tests and compatibility checks pass, and no source/test/package/git scope violation remains;
- the Primary has reviewed the complete final diff and Scale has no blocker/fix-now findings; and
- the temporary plan is no longer needed to operate or audit the workflow, with any durable decisions promoted into focused project docs rather than this plan.
