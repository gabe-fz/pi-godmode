# Godmode target workflow

> **Implementation status:** Phase 2 (FR-1, FR-3, and FR-4) is implemented: the normal-runtime `godmode_workflow` controller creates one append-acknowledged Primary packet, records checkout-derived red evidence or a narrow waiver, persists trusted Hand lifecycle transitions, and enforces pre-Hand TDD, sticky red-test, and bounded assignment scope integrity. Primary inspection, mandatory Scale, and later gates remain target behavior. The current runtime/security boundary remains the one in [`SPEC.md`](../SPEC.md).

## 1. Authority and unit of work

The **Primary** is the only authority for user intent, product scope, architecture, security/data policy, dependencies, migrations, release actions, review, acceptance, and user communication. In this workflow, **God** is an informal role label for that same Primary, never a separate actor or authority. Ledger and evidence records use the canonical actor name `Primary`. Eye, Hand, and Scale execute bounded assignments and escalate material ambiguity through the supervisor; they do not invent authority.

A work item is the smallest independently reviewable outcome. A work item is classified before implementation:

| Classification | Meaning | Typical evidence |
| --- | --- | --- |
| **Feature** | Adds a user-visible capability or a new supported behavior. | A new behavior works through its public interface and does not regress stated non-goals. |
| **Bugfix** | Corrects an incorrect, regressed, unsafe, or failing existing behavior. | A regression is reproduced, the red test fails for the old behavior, and the corrected behavior passes. |
| **Refactor/maintenance** | Changes internals, quality, or structure without changing the supported contract. | Existing contract checks remain green and scope is unchanged. |
| **Documentation/configuration** | Changes guidance, examples, configuration defaults, or operational instructions without executable behavior. | Links/examples/rendering/config validation as applicable. |
| **Test-only/tooling** | Changes validation machinery without changing the product contract. | The test/tooling change itself is exercised and its scope is reviewed. |

Classification is recorded once in the session ledger. If work spans classifications, split it into separately gated work items or escalate the boundary to the Primary.

## 2. God-authored specification packet

**Phase 2 implemented.** Before Hand receives a mutation assignment, the Primary writes a compact specification packet through `godmode_workflow`. The controller accepts only one fresh work item, stamps the Primary author and audited gate transitions, and persists through the active SessionManager only after exact append acknowledgement. It is intentionally minimal and must contain:

1. **Goal:** one sentence of the form: “An identified actor can achieve an observable outcome through an identified interface under stated constraints, evidenced by named checks.”
2. **Numbered functional requirements:** `FR-1`, `FR-2`, …; each `functionalRequirements` entry contains the exact ID, an observable behavior description, and its applicable interface. IDs must exactly agree with `requirementIds`.
3. **Non-goals:** explicit exclusions for this item. Non-goals are not hidden acceptance failures.
4. **Roadmap:** a short sequence of implementation and verification increments. Each item maps to requirement IDs and has exactly one canonical status: `pending`, `implemented-unverified`, `verified`, `blocked`, or `waived` with a reason. Deferred ideas belong in non-goals or follow-up work, not in the acceptance roadmap.
5. **Acceptance checks:** commands or interactions that can establish each applicable requirement.
6. **Expected paths and authority constraints:** what Hand may change and what remains forbidden.

The Primary authors this packet; Hand may ask questions or identify contradictions but may not silently broaden it. The packet is included in each fresh assignment rather than relying on conversation history.

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

The target workflow phases and permitted high-level transitions are:

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

**Phase 2 implemented.** For every feature or bugfix, and for any other executable change where a test can express the contract, the Primary authors red tests **before Hand starts**. A red test is a focused executable assertion of the intended requirement, not a placeholder or a test of implementation details.

The Primary must observe and record the intended failure before delegation. In normal runtime this is the `record-red` action of `godmode_workflow`; the controller derives the SHA-256 from the checkout and stamps the Primary actor, evidence ID, and timestamp:

- exact test/verification command and controlled environment;
- exit status and a bounded relevant output excerpt or artifact reference;
- requirement ID(s) covered; and
- confirmation that the failure is the missing behavior, not a broken fixture, dependency, setup, or unrelated pre-existing failure.

The assignment to Hand includes the red-test references and failure evidence. Setup or unrelated failure kinds are rejected rather than recorded as intended red. Phase 2 admission also verifies the referenced test still exists inside the checkout, matches the recorded SHA-256 content identity, contains a meaningful assertion, and is not skipped, todo, only, or an obvious tautology. Hand then makes the tests green by implementing the approved behavior. Hand must not weaken a red test by deleting assertions, broadening matchers, changing expected values to observed values, skipping it, marking it optional, or changing the test to follow the implementation. A test that appears incorrect or untestable is an escalation to the Primary; it is not permission to dilute the gate.

### Explicit TDD waivers

A waiver is narrow and recorded in the ledger. It names the item, the inapplicable test seam, the reason, the approver, date, scope, and compensating evidence. Valid examples include:

- this task changes documentation only and no executable behavior, so an executable red test would not exercise the requested contract;
- the change is a mechanical refactor with a complete existing contract suite and no new observable behavior; or
- a safe executable seam is genuinely unavailable, with the Primary documenting the limitation and an interface-matched manual/controlled check.

A user may explicitly waive TDD for a stated item. “Time pressure,” a Hand report, or a permanently broad project setting is not an implicit waiver. A waiver never waives review, evidence, security checks, or Primary-only acceptance. The implementation accepts a structured narrow waiver only with requirement coverage, named item/seam, Primary approver/actor, date, bounded scope, and compensating check/evidence; feature/bugfix waivers additionally require a genuinely unavailable safe executable seam. Documentation-only work can use the documented narrow waiver; documentation validation is still required.

## 5. Hand gate and handoff

**Phase 2 implemented.** After an admitted red result or waiver, Godmode persists `hand-running` before spawning Hand. It watches an admitted red-test file and its parent synchronously; any targeted write, rename, or removal is a sticky integrity compromise even when the original bytes are restored. Hand receives only an approved packet, expected mutation paths, red-test evidence (or the named waiver), and applicable evidence expectations. Hand:

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

The Primary must not treat a command string, screenshot, test claim, or Scale verdict as proof without inspecting the underlying result and relevant source.

## 7. Mandatory Scale review

For every **feature** and **bugfix**, a fresh-context **Scale review is mandatory before acceptance**. “When useful” is not sufficient. Scale reviews the actual diff, source, specification packet, red-test evidence, and independent validation evidence; it does not review only Hand's summary and it cannot accept work.

Scale must report evidence-backed findings with file/line references where applicable and classify each as:

- **blocker** — acceptance cannot proceed;
- **fix-now** — remediation is required before acceptance; or
- **optional** — useful follow-up that does not block this item.

Scale also states a verdict and residual uncertainty. The Primary owns the interpretation and final decision.

A Scale waiver is permitted only when:

- the user explicitly waives Scale for this named item; or
- a narrowly documented project policy identifies a bounded class of change, owner, risk limit, expiry/review date, and compensating independent evidence.

The waiver is recorded before acceptance and never means that the Primary may skip full-diff inspection or validation. A lack of Scale capacity is a blocked state, not an unrecorded waiver.

## 8. Remediation and re-review

A blocker or fix-now finding returns the item to `remediation`. The Primary resolves the finding into a bounded correction assignment for Hand, preserving the original requirements and red tests. One correction assignment is active at a time; uncontrolled loops are forbidden. Hand reports the new diff and verification, and the Primary repeats full-diff/material-file inspection for the changed area and any affected interface.

The item then returns to `scale-running` for a fresh Scale re-review of the remediation and its interaction with the original work. Scale must confirm disposition of every blocking finding. New blockers restart the same cycle. Optional findings are recorded as residual risk or roadmap work; they do not silently expand the assignment.

## 9. Acceptance

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

## 10. Current implementation checkpoint

The current implementation is the Phase 2 workflow authoring, packet, TDD admission, and Hand integrity gate. It intentionally preserves the existing runtime/security contract and does not claim Primary inspection, mandatory Scale acceptance, interface-evidence automation, or doctor behavior. Documentation-only work may use the narrow waiver described above; feature and bugfix work must use observed red evidence (or a valid genuinely-unavailable-safe-seam waiver), and Hand admission remains non-accepting. Packet expected paths and acceptance checks may be deliberately narrowed for Hand but never expanded; the immutable red test is identified by the packet without granting it mutation authority, and any watched-file event remains a sticky integrity failure even if bytes are restored.
