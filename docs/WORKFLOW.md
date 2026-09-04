# Godmode shipped workflow

> **Shipped behavior:** The normal-runtime `godmode_workflow` controller creates one append-acknowledged Primary packet, records complete inspection evidence and an all-surface interface-evidence matrix, binds Scale reviews to the exact latest completed run, enforces bounded waivers, invalidates stale gate evidence through capped remediation before fresh inspection and evidence, and provides bounded doctor diagnosis plus previewed allowlisted apply/recovery. The current runtime/security boundary remains the one in [`SPEC.md`](../SPEC.md). Repository-specific controlled interface checks are described in §12; this document does not claim unsupported browser or HTTP execution.

## AI-led migration flow

When the request is to migrate or modernize an existing project, the Primary first invokes the read-only model-facing `godmode_doctor` with `{ "action": "assess" }`. The tool supplies a bounded relative assessment only; it does not mutate or delete files and never imports legacy status as authority. The Primary then delegates Eye for bounded local-project research with no web/network access, synthesizes an exact plan naming files to create, modify, archive, or delete together with checks and risks, and stops to request explicit user approval of that exact plan. After approval, custom changes and exact-approved deletions proceed only through the normal gated workflow and Hand with exact `expectedPaths`; ambiguous user-owned files remain unchanged. The Primary independently inspects the result, gathers interface evidence, runs Scale, resolves findings, and accepts only after all gates pass.

`godmode_doctor` is distinct from the existing `/godmode doctor --apply` slash-command scaffolding flow. The model tool is read-only assessment only; slash `--apply` remains a read-only preview/token path for the two exact allowlisted scaffolding targets. `DoctorApplyManager` is not a legacy deletion mechanism.

## 1. Authority and unit of work

The **Primary** is the only authority for user intent, product scope, architecture, security/data policy, dependencies, migrations, release actions, review, acceptance, and user communication. Ledger and evidence records use the canonical actor name `Primary`. Eye, Hand, and Scale execute bounded assignments and escalate material ambiguity through the supervisor; they do not invent authority.

A work item is the smallest independently reviewable outcome. A work item is classified before implementation:

| Classification | Meaning | Typical evidence |
| --- | --- | --- |
| **Feature** | Adds a user-visible capability or a new supported behavior. | A new behavior works through its public interface and does not regress stated non-goals. |
| **Bugfix** | Corrects an incorrect, regressed, unsafe, or failing existing behavior. | A regression is reproduced, the red test fails for the old behavior, and the corrected behavior passes. |
| **Refactor/maintenance** | Changes internals, quality, or structure without changing the supported contract. | Existing contract checks remain green and scope is unchanged. |
| **Documentation/configuration** | Changes guidance, examples, configuration defaults, or operational instructions without executable behavior. | Links/examples/rendering/config validation as applicable. |
| **Test-only/tooling** | Changes validation machinery without changing the product contract. | The test/tooling change itself is exercised and its scope is reviewed. |

Classification is recorded once in the session ledger. If work spans classifications, split it into separately gated work items or escalate the boundary to the Primary.

## 2. Primary-authored specification packet

**Implemented.** Before Hand receives a mutation assignment, the Primary writes a compact specification packet through `godmode_workflow`. The controller accepts only one fresh work item, stamps the Primary author and audited gate transitions, and persists through the active SessionManager only after exact append acknowledgement. It is intentionally minimal and must contain:

1. **Goal:** one sentence of the form: “An identified actor can achieve an observable outcome through an identified interface under stated constraints, evidenced by named checks.”
2. **Numbered functional requirements:** `FR-1`, `FR-2`, …; each `functionalRequirements` entry contains the exact ID, an observable behavior description, and its applicable interface. IDs must exactly agree with `requirementIds`.
3. **Non-goals:** explicit exclusions for this item. Non-goals are not hidden acceptance failures.
4. **Roadmap:** a short sequence of implementation and verification increments. Each item maps to requirement IDs and has exactly one canonical status: `pending`, `implemented-unverified`, `verified`, `blocked`, or `waived` with a reason. Deferred ideas belong in non-goals or follow-up work, not in the acceptance roadmap.
5. **Acceptance checks:** commands or interactions that can establish each applicable requirement. The recorded Primary inspection must contain exactly one independent, evidence-backed passing check for every packet command; missing, duplicate, substituted, or failed checks cannot produce `evidence-ready`.
6. **Expected paths and authority constraints:** what Hand may change and what remains forbidden.

The Primary authors this packet; Hand may ask questions or identify contradictions but may not silently broaden it. The packet is included in each fresh assignment rather than relying on conversation history.

### Durable requirement traceability

| Requirement | Shipped control and evidence |
| --- | --- |
| **FR-1** | Classification and Primary-authored packet; `specify` validation and packet persistence tests. |
| **FR-2** | Canonical ledger record and derived checklist; transition/recovery tests. |
| **FR-3** | Primary-observed red test or narrow TDD waiver before Hand; admission tests. |
| **FR-4** | Bounded Hand assignment with immutable red-test and scope guard; integrity tests. |
| **FR-5** | Complete Primary status/diff/material-file inspection and independent checks. |
| **FR-6** | Fresh mandatory Scale review or bounded recorded waiver before acceptance. |
| **FR-7** | Bounded remediation scope followed by fresh inspection and Scale re-review. |
| **FR-8** | Interface-matched evidence matrix with explicit applicability for all eight surfaces. |

## 3. Canonical status and gates

The session ledger is the single source of workflow truth. Its canonical record contains one current **workflow phase** plus one status per roadmap item. A UI checklist, progress table, faculty footer, or plan checkbox is only a derived rendering of those fields and must never be stored as another checklist or status source. A derived view may show an item as verified only from recorded evidence, never from a faculty claim alone.

Roadmap item transitions are deliberately small:

```text
pending -> implemented-unverified -> verified
pending | implemented-unverified -> blocked
blocked -> pending | implemented-unverified
pending | implemented-unverified | blocked -> waived  (reason and authority required)
```

Hand may cause an item to be recorded as `implemented-unverified`; only the Primary can record `verified` or `waived`. Required roadmap items must be `verified` or validly `waived` before acceptance.

The shipped workflow phases and permitted high-level transitions are:

```text
draft -> classified -> specified -> red-test-ready
red-test-ready -> red-test-observed | tdd-waived
red-test-observed | tdd-waived -> hand-running
hand-running -> hand-handoff -> primary-verifying
primary-verifying -> evidence-ready | remediation
evidence-ready -> scale-running -> review-passed
evidence-ready -> scale-waived
review-passed | scale-waived -> accepted

scale-running -> remediation       (blocker or fix-now finding)
remediation -> hand-running
any active phase -> blocked        (unresolved decision, unsafe condition, or unavailable evidence)
blocked -> specified | red-test-ready | hand-running | primary-verifying | scale-running
review-passed -> rejected          (Primary determines outcome is not acceptable)
```

`accepted` is terminal for that work item. `tdd-waived` and `scale-waived` are gate-specific phases, not approval by themselves: each records the named gate, reason, scope, approver, and compensating evidence, after which the remaining gates still apply. The runtime mode states (`off`, `enabling`, `active`, `stopping`, `degraded`) and faculty lifecycle states are operational metadata, not alternate workflow phases.

Each phase or roadmap-status transition records the actor, timestamp, work-item ID, and evidence or decision reference. A checklist rendered from this record is disposable: deleting it cannot change workflow state.

## 4. Spec-driven TDD gate

**Implemented.** For every feature or bugfix, and for any other executable change where a test can express the contract, the Primary authors red tests **before Hand starts**. A red test is a focused executable assertion of the intended requirement, not a placeholder or a test of implementation details.

The Primary must observe and record the intended failure before delegation. In normal runtime this is the `record-red` action of `godmode_workflow`; the controller derives the SHA-256 from the checkout and stamps the Primary actor, evidence ID, and timestamp:

- exact test/verification command and controlled environment;
- exit status and a bounded relevant output excerpt or artifact reference;
- requirement ID(s) covered; and
- confirmation that the failure is the missing behavior, not a broken fixture, dependency, setup, or unrelated pre-existing failure.

The assignment to Hand includes the red-test references and failure evidence. Setup or unrelated failure kinds are rejected rather than recorded as intended red. Hand admission also verifies the referenced test still exists inside the checkout, matches the recorded SHA-256 content identity, contains a meaningful assertion, and is not skipped, todo, only, or an obvious tautology. Hand then makes the tests green by implementing the approved behavior. Hand must not weaken a red test by deleting assertions, broadening matchers, changing expected values to observed values, skipping it, marking it optional, or changing the test to follow the implementation. A test that appears incorrect or untestable is an escalation to the Primary; it is not permission to dilute the gate.

### Explicit TDD waivers

A waiver is narrow and recorded in the ledger. It names the item, the inapplicable test seam, the reason, the approver, date, scope, and compensating evidence. Valid examples include:

- this task changes documentation only and no executable behavior, so an executable red test would not exercise the requested contract;
- the change is a mechanical refactor with a complete existing contract suite and no new observable behavior; or
- a safe executable seam is genuinely unavailable, with the Primary documenting the limitation and an interface-matched manual/controlled check.

A user may explicitly waive TDD for a stated item. “Time pressure,” a Hand report, or a permanently broad project setting is not an implicit waiver. A waiver never waives review, evidence, security checks, or Primary-only acceptance. The implementation accepts a structured narrow waiver only with requirement coverage, named item/seam, Primary approver/actor, date, bounded scope, and compensating check/evidence; feature/bugfix waivers additionally require a genuinely unavailable safe executable seam. Documentation-only work can use the documented narrow waiver; documentation validation is still required.

## 5. Hand gate and handoff

**Implemented.** After an admitted red result or waiver, Godmode persists `hand-running` before spawning Hand. It watches an admitted red-test file and its parent synchronously; any targeted write, rename, or removal is a sticky integrity compromise even when the original bytes are restored. Hand receives only an approved packet, expected mutation paths, red-test evidence (or the named waiver), and applicable evidence expectations. Hand:

- changes only the approved (possibly deliberately narrowed) mutation scope and preserves unrelated work;
- keeps red tests intact and makes them green; the packet may identify the immutable test without granting Hand permission to mutate it;
- runs focused meaningful verification;
- does not mutate git history, index, branches, worktrees, remotes, releases, or deployments; and
- escalates before expanding product, architecture, security, data, dependency, migration, or public-interface scope.

An intact successful Hand completion is persisted as `hand-handoff`; a failed, stopped, rejected, timed-out, or compromised run is persisted as `blocked`. Watchers are disposed on every terminal, rollback, disable, and shutdown path. Hand's completion is a **handoff**, not a completion decision. The handoff capsule names changed files, implementation summary, commands and outcomes, incomplete work, surprises, residual risks, and decisions still needed. The Primary records it as evidence and does not promote its checklist to accepted status.

## 6. Primary inspection gate

After Hand returns, the Primary must independently:

1. inspect repository status and the complete relevant diff;
2. read every materially changed file, not only the files named by Hand;
3. investigate all out-of-scope changes and unexplained generated/artifact changes;
4. compare the implementation with every numbered functional requirement and non-goal;
5. run each required acceptance check independently, unless unsafe or unavailable and explicitly documented;
6. inspect test quality, including that red tests are still meaningful and cover the intended failure; and
7. collect interface-matched evidence described in [`EVIDENCE.md`](./EVIDENCE.md).

The Primary must not treat a command string, screenshot, test claim, or Scale verdict as proof without inspecting the underlying result and relevant source. During complete inspection, `record-inspection` captures status and the complete tracked/staged/untracked diff with fixed non-shell Git arguments into bounded owner-only OS-temporary artifacts. The ledger retains only hashes, byte bounds, timestamps, expiry, and artifact paths; caller-supplied fingerprints/references are rejected. Material and out-of-scope classifications must exactly cover captured status, and the checkout/artifacts are reverified before Scale admission, review recording, and acceptance. Scale receives those artifacts plus every material and investigated out-of-scope path as read-only context. Active inspection, evidence, and recovery references are explicitly cleaned at lifecycle boundaries; expiry makes artifacts unusable. Startup/shutdown stale-candidate detection is bounded and read-only, so crash leftovers defer to host OS temporary-file retention because pathname deletion cannot be made race-safe with this runtime.

## 7. Interface-matched evidence matrix

The shipped interface gate adds `interface-matched-v1` as an additive packet policy for every newly Primary-authored classification. Legacy recovered records without the additive fields remain structurally compatible. Every declared requirement has exactly one applicability decision for each canonical surface: `browser-ui`, `tui`, `api`, `cli`, `library`, `persistence-migration`, `build-config`, and `documentation`. Applicable pairs require a check spec and passing Primary-observed evidence; not-applicable pairs require a bounded reason and no check/evidence pretending to cover them. Failed or blocked observations remain visible but cannot satisfy the gate.

`record-evidence` and its `record-evidence-matrix` alias accept bounded check specs, decisions, observed interaction text, outcomes, controlled environments, and explicit artifact input paths. They never execute invocation text or discovered commands. The bounded importer accepts only regular non-symlink checkout/approved-temp files, rejects binary/NUL and secret-like authority evidence, copies accepted files to owner-only temporary directories, and persists descriptors (hash, size, expiry), not raw artifacts. Scale admission and acceptance require a complete fresh matrix; a failed or blocked matrix can be replaced only for the same inspection, while a passing matrix is immutable. Replacement snapshots remain in the append-only ledger, superseded descriptors leave active generic evidence, and old temporary artifacts are removed only after acknowledgement. Remediation invalidates current matrix descriptors and requires fresh inspection and evidence.

## 8. Mandatory Scale review

For every **feature** and **bugfix**, a fresh-context **Scale review is mandatory before acceptance**. “When useful” is not sufficient. Scale reviews the actual diff, source, specification packet, red-test evidence, and independent validation evidence; it does not review only Hand's summary and it cannot accept work.

Scale must report evidence-backed findings with file/line references where applicable and classify each as:

- **blocker** — acceptance cannot proceed;
- **fix-now** — remediation is required before acceptance; or
- **optional** — useful follow-up that does not block this item.

Scale also states a verdict and residual uncertainty. The Primary owns the interpretation and final decision. Godmode persists a cryptographic Scale admission before spawn, append-binds the returned run ID, and records review only from the exact completed admission/run. Unbound, recovered-stale, or unrelated runs fail closed.

A Scale waiver is permitted only when:

- the user explicitly waives Scale for this named item; or
- a narrowly documented project policy identifies a bounded class of change, owner, risk limit, expiry/review date, and compensating independent evidence.

The waiver is recorded before acceptance and never means that the Primary may skip full-diff inspection or validation. A lack of Scale capacity is a blocked state, not an unrecorded waiver. User waiver provenance is an exact active-branch message `WAIVE SCALE: <work-item-id>`; caller-supplied approval references have no authority. Policy waiver provenance is an existing bounded, checkout-confined, non-symlink JSON file naming the exact item, scope, reason, risk limit, owner, compensation, and canonical expiry/review timestamps; the controller reads and hashes it and never creates policy.

## 9. Remediation and re-review

A blocker or fix-now finding returns the item to `remediation`. The `record-scale-review` action requires the Primary to supply a nonempty `correctionScope` (or `remediationPaths`) of normalized checkout-relative paths, and the controller persists it only when it is a subset of packet `expectedPaths`; finding summaries are evidence, never mutation paths. Hand's correction assignment must be a nonempty subset of that scope, preserving the original requirements and red tests. One correction assignment is active at a time; uncontrolled loops are forbidden. Hand reports the new diff and verification, and the Primary repeats full-diff/material-file inspection for the changed area and any affected interface.

The item then returns to `scale-running` for a fresh Scale re-review of the remediation and its interaction with the original work. Scale must confirm disposition of every blocking finding. New blockers restart the same cycle. Optional findings are recorded as residual risk or roadmap work; they do not silently expand the assignment.

## 10. Acceptance

Only the Primary can set `accepted` or communicate completion to the user. Acceptance requires, as applicable:

- a complete specification packet and classification;
- observed red-test failure or a narrow recorded TDD waiver;
- Hand's green verification without weakened tests;
- Primary full-diff and materially changed-file inspection;
- interface-matched evidence for each applicable surface;
- mandatory Scale review for feature/bugfix, or a recorded permitted waiver;
- remediation and Scale re-review for all blocking findings; and
- explicit residual risks, unavailable checks, and durable follow-up.

Neither Hand, Scale, a passing command, a derived checklist, nor a ledger transition performed by another actor can accept the item.

## 11. Shipped implementation checkpoint

The shipped implementation provides the workflow authoring, packet, TDD admission, Hand integrity, Primary inspection, interface-matched evidence, mandatory Scale, waiver, bounded remediation, doctor diagnosis, and previewed apply/recovery gates. It intentionally preserves the existing runtime/security contract; doctor does not execute discovered commands, and apply writes only the two exact allowlisted targets after explicit `trusted === true`, idle proof, and `activeFaculty: null`, with missing proofs denied. Replacement post-write failures automatically attempt verified restoration; an unproven rollback returns an explicit partial/error result with a process-local recovery token. Accepted runtime records include a bounded completion capsule; raw artifacts and transcripts are never persisted. Documentation-only work may use the narrow waiver described above; feature and bugfix work must use observed red evidence (or a valid genuinely-unavailable-safe-seam waiver), and Hand admission remains non-accepting. Packet expected paths and acceptance checks may be deliberately narrowed for Hand but never expanded; the immutable red test is identified by the packet without granting it mutation authority, and any watched-file event remains a sticky integrity failure even if bytes are restored.

## 12. Controlled repository interface checks

The structural interface matrix in the workflow record is distinct from concrete repository readiness checks. For this package, controlled local checks exercise the registered TUI command handler with deterministic fake UI/context (there is no standalone PTY executable), public package extension registration and consumer import, disposable SessionManager persistence and reopen, doctor/apply CLI-like command parsing and invocation, typecheck/build/configuration, and Markdown/package-link validation. Browser UI and HTTP API are explicitly **not applicable** because this repository ships neither; no browser, network, or arbitrary process execution is implied by the matrix. The remaining TUI limitation is the absence of a real PTY executable and is recorded as residual risk rather than claimed as evidence.
