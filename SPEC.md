# Pi Godmode Build Specification

**Status:** The shipped workflow includes Primary packet/TDD gates, complete inspection, interface-matched evidence, mandatory Scale review, bounded remediation, doctor diagnosis, previewed allowlisted apply/recovery, and safe legacy hint reconciliation (FR-1 through FR-12). Documentation and package traceability are covered by FR-13. No publication, tagging, or release action is performed by this repository.
**Product:** `pi-godmode`
**Initial specification version:** 2

## 1. Summary

Pi Godmode is a default-on orchestration mode for Pi. At every session start, after the ordinary tool baseline is initialized, the current interactive session automatically attempts to become active on a configured high-tier model. The session retains responsibility for understanding requests, planning, decisions, user interaction, review, validation, and final acceptance.

The primary session delegates bounded execution through three specialized **Divine Faculties** backed by `pi-subagents`:

- **Eye** — read-only reconnaissance and codebase understanding;
- **Hand** — implementation in the active checkout; and
- **Scale** — independent review and validation.

Godmode is a policy and user-experience layer, not a child-process manager. `pi-subagents` owns child launch, model execution, supervisor communication, status, steering, stopping, lifecycle artifacts, and completion delivery. Godmode owns the mode toggle, primary-model lease, faculty definitions, delegation restrictions, single-active-faculty policy, and final-authority guidance.

Godmode deliberately does not use an advisory-oracle escalation flow. The high-tier primary session is the planning and judgment authority. Faculties execute bounded assignments and escalate unresolved decisions upward through the native `pi-subagents` supervisor channel.

This specification also defines the shipped spec-driven workflow, evidence gates, ledgers, and doctor. The normal-runtime controller implements the Primary packet, red-test/TDD admission, append-acknowledged transitions, Hand integrity/scope gates, complete Primary inspection, interface-matched evidence, mandatory Scale, bounded waivers, capped remediation, bounded static diagnosis, previewed allowlisted apply/recovery, and safe non-authoritative legacy hint reconciliation. The existing runtime/security contract in sections 6–18 remains the compatibility baseline. Focused workflow details are in [`docs/WORKFLOW.md`](./docs/WORKFLOW.md), evidence details in [`docs/EVIDENCE.md`](./docs/EVIDENCE.md), state/memory details in [`docs/STATE_AND_MEMORY.md`](./docs/STATE_AND_MEMORY.md), and doctor/migration details in [`docs/DOCTOR.md`](./docs/DOCTOR.md).

## 2. Product principles

1. **One authority.** The primary session owns intent, decisions, orchestration, review, acceptance, and user communication.
2. **Execution flows downward; decisions flow upward.** Faculties perform bounded work and ask rather than inventing product, scope, architecture, security, or release decisions.
3. **The primary is intentionally high tier.** Enabling Godmode selects an explicitly configured model and thinking threshold; disabling restores the previous session state.
4. **Delegation is narrow.** Godmode exposes three fixed faculties rather than the complete workflow, scheduling, fanout, or arbitrary-agent surface.
5. **One active faculty.** The first release serializes all delegation. This provides a simple checkout-ownership story and deterministic supervision.
6. **Fresh, explicit assignments.** Faculties receive compact standalone contracts rather than relying on the primary conversation transcript.
7. **Handoffs are evidence.** A Hand or Scale result never replaces the primary session’s own inspection and judgment.
8. **Reuse the substrate.** Process lifecycle, transport, status, artifacts, and child UI remain owned by `pi-subagents` through its documented public APIs.

## 3. Goals

- Provide one obvious `/godmode` toggle in the interactive Pi session.
- Promote the active session to an explicitly allowlisted high-tier model and thinking level while enabled.
- Restore the exact prior model and thinking level when disabled.
- Give the model a small delegation API using Eye, Hand, and Scale terminology.
- Pin every faculty to an exact configured provider, model, thinking level, prompt, and tool allowlist.
- Prevent the Godmode primary from launching arbitrary agents or workflow scripts while the mode is active.
- Permit only one active faculty at a time.
- Prevent primary-session mutation while the Hand is active in the shared checkout.
- Support live faculty questions through `contact_supervisor` and `subagent_supervisor`.
- Reuse `pi-subagents` FleetView, status, lifecycle artifacts, completion wakes, steering, and stop behavior.
- Require the primary session to inspect and independently validate Hand work before reporting completion.
- Provide the shipped spec-driven TDD, evidence, mandatory Scale, ledger, and Primary-only acceptance workflow.
- Keep Godmode’s owned runtime small enough to understand as a mode adapter.

## 4. Non-goals

Godmode will not implement:

- its own subprocess spawning, RPC framing, environment filtering, or signal escalation;
- its own inter-process messaging or question protocol;
- arbitrary workflow scripts, schedules, missions, chains, fanout, or nested delegation;
- multiple simultaneous faculties;
- parallel writers or worktree orchestration;
- arbitrary agent, model, tool, extension, or working-directory selection by the model;
- automatic commits, pushes, pull requests, merges, releases, or deployment;
- automatic acceptance based solely on a child result or reported test command;
- a second fleet dashboard, transcript viewer, or process inspector;
- an oracle or peer authority above or beside the primary session.

## 5. Terminology

| Term | Meaning |
| --- | --- |
| **Godmode** | The session-local mode defined by this package; it defaults active after session startup succeeds. |
| **Primary** | The interactive, high-tier Pi session that owns decisions and acceptance. |
| **Primary-authored** | Authority-bearing workflow content written by the Primary; durable ledger/evidence records use `Primary`. |
| **Divine Faculty** | One configured `pi-subagents` child role available through Godmode. |
| **Eye** | Read-only faculty for reconnaissance and explanation. |
| **Hand** | Mutation-capable faculty for bounded implementation. |
| **Scale** | Read-only faculty for independent review and validation. |
| **Assignment** | The standalone bounded contract sent to one faculty. |
| **Handoff** | A faculty’s result and lifecycle evidence returned to the Primary. |
| **Active faculty** | The sole assignment currently queued, running, paused, or stopping. |
| **Model lease** | The preserved prior Primary model/thinking state plus the selected Godmode state. |

Canonical faculty agent names are:

```text
godmode-eye
godmode-hand
godmode-scale
```

## 6. User experience

### 6.1 Installation

```bash
pi install npm:pi-subagents
pi install npm:pi-godmode
```

Restart Pi after installation. Both packages must be loaded in the same parent process.

### 6.2 Command

Godmode registers exactly one user-facing slash command:

```text
/godmode                 # TUI toggle; outside TUI, bounded read-only state
/godmode doctor          # read-only readiness assessment
/godmode doctor --apply  # bounded preview and one-time token
/godmode doctor --apply --replace <allowed path>  # one exact replacement preview
/godmode doctor --apply --confirm <token>  # explicit trusted/idle apply
/godmode doctor --apply --recover <token>  # bounded replacement recovery
```

The current runtime keeps one command with an exact parser: empty arguments toggle, `doctor` runs bounded read-only diagnosis, `doctor --apply` returns a preview/token without writing, exact `--replace` returns a one-target replacement preview, and only tokenized `--confirm`/`--recover` can mutate or restore. Unknown arguments fail with usage guidance and never silently toggle or apply changes. Doctor is available regardless of trust or active-mode state; apply requires a trusted idle project with no active faculty. The diagnostic/apply contract is defined in section 22 and [`docs/DOCTOR.md`](./docs/DOCTOR.md).

At every `session_start`, Godmode first restores the ordinary active-tool baseline and then attempts transactional enablement. If startup enablement fails, the mode rolls back to off, session startup continues, and the UI receives an actionable error notification; after fixing the reported issue, run `/godmode` to retry.

In interactive TUI mode, bare `/godmode` directly toggles: off enables Godmode, while active or degraded disables it. Disabling never silently leaves an assignment running. When a faculty is active, the direct toggle-off uses the explicit stop-and-disable cleanup path and waits for terminal package status before restoring the previous Primary state.

Outside TUI mode, bare `/godmode` is read-only and reports the current bounded state. Mode mutation remains restricted to the interactive TUI command. Doctor is read-only by default in every host mode.

### 6.3 Footer

While enabled, Godmode shows one persistent status line:

```text
GODMODE ● idle
GODMODE ● Eye running
GODMODE ● Hand running
GODMODE ● Scale running
GODMODE ● decision requested
GODMODE ● Hand deadline pending
GODMODE ● Hand deadline extended
GODMODE ● Hand hard deadline
GODMODE ● result ready
GODMODE ● degraded
```

FleetView remains the detailed child-status surface. Godmode does not reproduce its transcript, tool timers, tokens, tools, or stop controls; its own bounded deadline timestamps and remaining times are included in status.

### 6.4 Primary behavior

While enabled, the Primary follows these rules:

- personally understand the request and inspect load-bearing source;
- retain all user-facing communication and material decisions;
- perform genuinely tiny, low-risk changes directly when delegation would add no value;
- delegate reconnaissance to Eye;
- delegate implementation to Hand;
- delegate independent post-implementation review to Scale; for every feature or bugfix, Scale review is mandatory before acceptance unless the user explicitly waives it or a narrowly documented policy waiver applies;
- never use a faculty to decide product intent, architecture authority, security policy, release authority, or acceptance;
- never edit the checkout concurrently with Hand;
- after delegation, return control rather than independently repeating or continuing the Faculty's assigned work while it is active, except to answer material supervisor questions or handle an explicit user interruption;
- treat faculty reports and command claims as evidence;
- inspect the complete diff and every materially changed file after Hand finishes;
- independently run the required validation before presenting completion;
- send one bounded correction assignment when necessary rather than allowing uncontrolled loops.

Feature work, changes spanning multiple implementation files, broad refactors, and changes to public APIs, persisted data, authentication, security, concurrency, dependencies, or migrations should normally be assigned to Hand.

## 7. Model-facing tools

Godmode tools are registered at extension load and activated only while the mode is enabled. While enabled, the ordinary model-facing `subagent` execution and `subagent_wait` tools are removed from the active tool set and replaced with the constrained tools below. Faculty completion is delivered asynchronously, so after delegation the Primary does not duplicate the active Faculty's assignment, poll, or wait with short timeouts. Package-owned supervisor reply support remains available.

### 7.1 `godmode_delegate`

```ts
godmode_delegate({
  faculty: "eye" | "hand" | "scale",
  title: string,
  task: string,
  contextFiles?: string[],
  expectedPaths?: string[],
  acceptanceChecks?: string[],
  constraints?: string[]
}) -> {
  runId: string,
  faculty: "eye" | "hand" | "scale",
  agent: "godmode-eye" | "godmode-hand" | "godmode-scale",
  state: "queued" | "running"
}
```

Validation rules:

- `title` is 1–160 characters.
- `task` is nonempty and bounded to 32 KiB.
- arrays are bounded, deduplicated, and contain nonempty strings;
- relative `contextFiles` remain checkout-confined; an in-checkout absolute context path is normalized to checkout-relative form, while an explicitly absolute outside-checkout context path is accepted and preserved as absolute; parent traversal and symlink escapes originating inside the checkout are rejected;
- every `expectedPaths` entry remains checkout-confined and is normalized to checkout-relative form; absolute paths that resolve outside, traversal, and checkout-originating symlink escapes are rejected, including when Eye or Scale reinterpret expected paths as context;
- external context paths and their contents are untrusted and may expose sensitive data;
- `hand` requires nonempty `expectedPaths` and `acceptanceChecks`;
- `eye` and `scale` reject mutation-oriented instructions; any supplied `expectedPaths` are safely reinterpreted as additional deduplicated `contextFiles` rather than mutation scope;
- the current Pi project must be trusted;
- Godmode must be active and healthy;
- no other faculty may be active;
- the resolved faculty launch contract must match its configured model, thinking, tools, and extension restrictions.

In `contextFiles`, absolute paths that resolve within the active checkout are normalized to checkout-relative form, while explicitly absolute paths that resolve outside it are preserved as absolute context. Relative context paths remain checkout-confined. For Eye and Scale, `expectedPaths` are first subjected to the stricter checkout-only policy, then safely reinterpreted as additional deduplicated `contextFiles`; they do not grant read-only faculties mutation scope or permit external paths.

The extension converts these fields into one compact assignment containing:

1. role and authority boundary;
2. goal and approved behavior;
3. explicit starting context;
4. expected mutation scope when applicable;
5. constraints and non-authority rules;
6. validation expectations;
7. required handoff format; and
8. decision-escalation instructions.

The model cannot provide a child model, thinking override, cwd, worktree option, workflow script, output path, arbitrary acceptance policy, or arbitrary agent name.

The extension sends an async single-child spawn through the public `subagents:rpc:v1` interface with:

- exact configured faculty agent;
- exact configured provider/model and thinking level;
- current canonical checkout;
- `context: "fresh"`;
- one child only;
- no workflow script;
- no worktree;
- no schedule;
- no nested delegation; and
- package-managed lifecycle artifacts.

### 7.2 `godmode_control`

```ts
godmode_control(
  | { action: "status" }
  | { action: "steer"; message: string }
  | { action: "stop"; reason?: string }
  | { action: "extend"; extensionMs: number }
) -> GodmodeStatus
```

Because Godmode permits one active faculty, no child ID is model-selectable.

- `status` reconciles the remembered package run with public `pi-subagents` status.
- `steer` sends acknowledged guidance to the exact active run through public RPC.
- `stop` stops the exact active run and retains the package lifecycle result.
- `extend` is available only after a soft deadline is pending. It grants one explicit extension of 1–300,000 milliseconds to the hard deadline, limited by headroom reserved in the immutable launch backstop; the action cannot renew a run indefinitely.

Steering does not change the faculty’s role, tools, model, cwd, or assignment authority.

### 7.3 Supervisor decisions

Faculties use the native child tool:

```ts
contact_supervisor({
  reason: "need_decision" | "interview_request" | "progress_update",
  message: string
})
```

The Primary replies through package-owned `subagent_supervisor`. Godmode does not create a parallel messaging protocol.

A Faculty must escalate before:

- expanding requested behavior or expected paths materially;
- making a product or UX choice not settled by the assignment;
- changing architecture or a public interface beyond the approved contract;
- changing authentication, authorization, security, or data-handling policy;
- adding dependencies or migrations not explicitly authorized;
- performing publication, version-control, release, or deployment actions.

## 8. Divine Faculty definitions

Godmode registers its faculties through the documented `pi-subagents` runtime-agent registration API. Registrations exist only while Godmode is enabled and are disposed when the mode is disabled.

### 8.1 Eye

Purpose: economical codebase reconnaissance and explanation.

Effective tools:

```text
read, grep, find, ls
```

Eye must:

- remain read-only;
- start from the supplied context files and named seams;
- follow imports or references only as needed;
- distinguish observed facts from inference;
- return relevant paths, symbols, data flow, constraints, risks, and unanswered questions;
- stop once it has enough evidence for the Primary to proceed.

Eye must not propose itself as a decision authority or launch other agents.

### 8.2 Hand

Purpose: economical bounded implementation in the shared checkout.

Effective tools:

```text
read, grep, find, ls, bash, edit, write
```

Hand must:

- implement only the approved assignment;
- preserve unrelated changes;
- remain within expected paths unless the Primary approves an expansion;
- use focused tests or another meaningful verification method;
- avoid mutating git history, the index, branches, worktrees, remotes, or releases;
- ask the Primary rather than guess when an authority boundary is reached;
- return changed files, implementation summary, commands with outcomes, incomplete work, surprises, residual risks, and decisions still needed.

Hand is the sole mutation-capable faculty.

### 8.3 Scale

Purpose: fresh-context independent review of a plan, diff, implementation, or validation evidence.

Effective tools:

```text
read, grep, find, ls
```

Scale must:

- remain read-only;
- inspect the actual requested source and diff rather than trust a Hand summary;
- compare behavior against the assignment and acceptance checks;
- report only evidence-backed findings;
- include file and line references when applicable;
- classify findings as blocker, fix-now, or optional;
- state a concise verdict and residual uncertainty.

Scale provides evidence to the Primary and never accepts work itself.

## 9. Configuration

Godmode reads trusted user-local configuration from:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/godmode/config.json
```

Example:

```json
{
  "schemaVersion": 1,
  "godmodePolicy": {
    "allowedModels": [
      { "provider": "openai-codex", "model": "gpt-5.6-sol" }
    ],
    "minimumThinking": "medium"
  },
  "faculties": {
    "eye": {
      "provider": "openai-codex",
      "model": "gpt-5.6-luna",
      "thinking": "xhigh",
      "timeoutMs": 900000
    },
    "hand": {
      "provider": "openai-codex",
      "model": "gpt-5.6-luna",
      "thinking": "xhigh",
      "timeoutMs": 1800000
    },
    "scale": {
      "provider": "openai-codex",
      "model": "gpt-5.6-terra",
      "thinking": "medium",
      "timeoutMs": 900000
    }
  }
}
```

Rules:

- unknown schema versions fail closed;
- every provider and model ID is exact and nonempty;
- Godmode allowed models are nonempty;
- the minimum Godmode thinking level is `medium`, `high`, or `xhigh`;
- each faculty declares one exact model, thinking level, and bounded timeout;
- `timeoutMs` is a soft elapsed deadline. At that time Godmode sends a non-interrupting `follow_up` checkpoint request and marks the run deadline-pending;
- Godmode derives a finite hard backstop without extra configuration: the grace period is the soft timeout for runs below five minutes, otherwise five minutes. The hard backstop is soft timeout plus that grace (bounded by the launch contract maximum);
- the underlying pi-subagents launch receives a finite outer timeout large enough for the one permitted five-minute extension because its public API cannot update a live run deadline;
- faculty models may not reuse a configured Godmode provider/model tuple;
- no fallback model is inferred;
- unavailable models or authentication failures prevent enable or delegation;
- the installed `pi-subagents` model scope must permit each exact faculty model;
- Godmode does not rewrite Pi or `pi-subagents` settings automatically.

## 10. Enable sequence

Enabling is transactional:

1. Confirm the project is Pi-trusted.
2. Load and validate Godmode configuration.
3. Verify compatible `pi-subagents` availability using public RPC `ping`.
4. Require advertised async spawn, status, acknowledged non-recovering steer, stop, async completion correlation, fleet status, and capability-ceiling support needed by the implementation.
5. Preserve the exact current Primary model and thinking level.
6. Select the first available authenticated configured Godmode model, preferring the current model when eligible.
7. Apply and verify the configured minimum thinking level.
8. Register Eye, Hand, and Scale through the public runtime-agent API.
9. Register a session-scoped capability ceiling allowing only the three canonical faculties, their bounded tool union, and no ambient child extensions.
10. Preflight every faculty and verify the exact resolved agent, model candidate, thinking level, tools, cwd policy, extension restrictions, and fresh-context contract.
11. Save the current active-tool membership that Godmode will change.
12. Deactivate the ordinary model-facing `subagent` execution and `subagent_wait` surfaces and activate `godmode_delegate`, `godmode_workflow`, and `godmode_control` while retaining supervisor response support.
13. Mark the mode active, add Primary guidance, and update the footer.

Any failure disposes partial registrations and ceilings, restores changed tools, restores the prior model/thinking state, clears the footer, and returns to off.

## 11. Disable and shutdown sequence

Normal disable:

1. Reject new assignments.
2. If a faculty is active, require explicit stop-and-disable confirmation.
3. Stop the exact remembered `pi-subagents` run through public RPC.
4. Reconcile until the package reports terminal lifecycle status or return a visible degraded cleanup error.
5. Dispose the capability ceiling and runtime faculty registrations.
6. Reverse only the active-tool changes owned by Godmode.
7. Restore the preserved Primary model and thinking level.
8. Clear Godmode guidance, remembered run state, and footer.
9. Return to off.

On Pi session shutdown, Godmode requests stop for its active assignment, disposes its registrations, and restores the model lease when the host lifecycle permits. All stop and disposal operations are idempotent.

## 12. State model

Mode states:

```text
off -> enabling -> active -> stopping -> off
                   active -> degraded -> stopping
```

Delegation states:

```text
idle -> launching -> running -> attention -> running
                           -> stopping -> terminal -> idle
                           -> terminal -> idle
```

Deadline states are tracked independently of lifecycle state:

```text
normal -> pending -> extended
                  -> hard -> stopping -> terminal
```

At `pending`, Godmode requests a checkpoint with `steer` mode `follow_up`, which queues delivery after the current tool/turn boundary rather than interrupting a healthy Faculty. At `hard`, Godmode requests a stop and the pi-subagents launch also carries the finite outer backstop. A supervisor may transition `pending` to `extended` once, with a maximum five-minute extension when the immutable launch backstop has sufficient reserved headroom.

Rules:

- only `active` and `idle` may create an assignment;
- the active slot is reserved before RPC spawn;
- launch failure releases the slot;
- the slot remains reserved while public status is queued, running, paused, needs-attention, or stopping;
- terminal completion is correlated to the exact package run ID;
- uncertain status fails closed and keeps the slot reserved;
- degraded mode blocks new delegation but preserves status, steer when supported, stop, and disable recovery;
- duplicate and late completion notifications are idempotent.

## 13. Shared-checkout mutation policy

Godmode uses the Primary’s canonical checkout for every faculty.

- Only Hand has mutation tools.
- Only one faculty may be active, so two Hands cannot overlap.
- While Hand is active, Godmode blocks Primary mutation tool calls including `bash`, `edit`, `write`, `apply_patch`, and equivalent configured mutation tools.
- The documented read-only web tools `web_search`, `fetch_content`, and `get_search_content` remain available to the Primary while Hand is active; unknown and mutation-capable tools remain blocked.
- Eye and Scale can never be used as a path to mutation tools because their effective child tool allowlists are verified during preflight.
- Human edits and unrelated Pi sessions remain outside Godmode’s authority and must be considered during final inspection.
- Godmode never runs git mutation, merge, publication, or rollback operations automatically.

## 14. Primary review and completion

A Hand handoff begins review; it does not end the user task.

The Primary must:

1. Read the assignment and Hand result.
2. Inspect repository status and the complete relevant diff.
3. Open every materially changed file.
4. Investigate changes outside expected paths.
5. Check behavior, scope, compatibility, security, error handling, and unnecessary complexity.
6. Assess test quality and whether the requested behavior was actually exercised.
7. Independently run each required acceptance check unless unsafe or unavailable.
8. Require a fresh-context Scale review before accepting every feature or bugfix, unless a permitted waiver is recorded; resolve all Scale findings against source evidence.
9. Launch at most one bounded correction Hand assignment at a time when fixes are required, then require Scale re-review.
10. Present completion only after personally determining that the requested outcome is satisfied.

The final user response names:

- what the Hand changed;
- what the Primary inspected;
- validation independently performed;
- any Scale findings and their disposition; and
- remaining risks or unverified behavior.

## 15. Public integration boundaries

Godmode may use only documented `pi-subagents` public surfaces:

- `subagents:rpc:v1:ready`;
- `subagents:rpc:v1:request` and correlated reply events;
- RPC methods `ping`, `spawn`, `status`, `steer`, and `stop`;
- public async-completion correlation advertised by `ping`;
- runtime-agent registration API;
- launch-contract preflight API;
- session-scoped capability-ceiling API; and
- package-owned supervisor and FleetView behavior.

Private `pi-subagents` modules, run-directory implementation details, broker internals, and child process handles are forbidden.

Godmode pins a compatible `pi-subagents` peer range and fails enable with an actionable version/capability error when the installed public contract is insufficient.

## 16. Security and trust

- Godmode operates only in a Pi-trusted project.
- Faculties run under the same operating-system account as the Primary; tool allowlists are policy controls, not an OS sandbox.
- Repository content and child output are untrusted model input.
- Explicit external context paths and fetched web content are untrusted input, may contain malicious instructions, and may expose sensitive data to the faculty or model.
- Capability ceilings prevent the Primary from widening faculty identity, tools, or ambient extensions through model-visible parameters.
- Exact model configuration and strict preflight prevent silent fallback to the Primary model.
- Assignment text never grants version-control, publication, deployment, credential, or release authority.
- Godmode writes no credentials or environment values to its own status.
- Lifecycle and transcript sensitivity follow the documented `pi-subagents` artifact policy and are called out during installation.
- The Primary’s final inspection is the trust boundary for Hand output.

## 17. Package structure

Shipped package structure:

```text
package.json
README.md
SPEC.md
src/
  extension.ts          # registration and Pi lifecycle hooks
  mode.ts               # compact mode/model-lease state
  config.ts             # Godmode schema and loading
  model-lease.ts        # select, verify, and restore Primary state
  subagents-client.ts   # bounded public RPC adapter
  faculties.ts          # runtime definitions and assignment rendering
  ceiling.ts            # capability-ceiling registration
  tools.ts              # delegate/control schemas and handlers
  mutation-guard.ts     # Primary shared-checkout write guard
  status.ts             # footer and bounded snapshots
  types.ts

test/
  unit/
  integration/
  fixtures/
```

Architectural boundaries:

- `mode.ts` is the only owner of Godmode state and the active run ID.
- `subagents-client.ts` knows the public RPC event envelope but no package internals.
- `faculties.ts` owns prompts, tool declarations, and assignment rendering.
- `model-lease.ts` owns all Primary model/thinking changes.
- `mutation-guard.ts` observes mode snapshots and never controls child processes.
- Pi-subagents remains authoritative for child lifecycle and artifacts.

## 18. Testing strategy

### 18.1 Unit tests

- configuration version, exact model tuples, timeouts, and Godmode/faculty separation;
- model lease acquisition, candidate failure, verification, and restoration;
- assignment schema bounds, path traversal rejection, deduplication, and Hand-required fields;
- Eye/Hand/Scale prompt snapshots and authority boundaries;
- capability-ceiling contents and disposal;
- active-tool activation and conservative restoration;
- single-active-faculty admission;
- mode and delegation state transitions;
- mutation guard behavior for Hand versus Eye/Scale;
- bounded status rendering;
- duplicate completion and late-reply handling.

### 18.2 Integration tests with a fake public subagents owner

- successful `ping`, faculty registration, preflight, and enable;
- missing or incompatible `pi-subagents` failure with full rollback;
- async Eye, Hand, and Scale spawn envelopes;
- exact model/thinking/cwd/context propagation;
- arbitrary model, agent, workflow, cwd, and tool selection being impossible through Godmode schemas;
- active slot rejection before a second spawn;
- supervisor question visibility and reply ownership through package behavior;
- acknowledged steering to the exact active run;
- stop-and-disable ordering;
- completion wake correlation and slot release;
- ambiguous or lost status degrading rather than admitting another Hand;
- session shutdown cleanup and idempotent disposal;
- Primary mutation blocking during an active Hand.

### 18.3 Real integration tests

In a disposable trusted repository with a non-billing or controlled model setup:

1. Enable selects and verifies the configured high-tier Primary.
2. Eye inspects a repository without mutation.
3. Hand performs a bounded tested change.
4. Hand asks a supervisor decision and continues from the exact reply.
5. Primary mutation is blocked while Hand runs.
6. Scale independently reviews the resulting diff; for feature/bugfix work this review is mandatory before acceptance unless explicitly waived under the shipped workflow.
7. Primary runs validation and reports the final result.
8. Steering reaches a slow active faculty.
9. Stop-and-disable terminates the assignment and restores the prior model.
10. Authentication, unavailable model, and provider failure produce actionable terminal states without fallback.

## 19. Delivery phases

### Shipped milestone — Toggle and Eye

- package scaffold;
- config and Primary model lease;
- public `pi-subagents` capability detection;
- runtime Eye registration and capability ceiling;
- `/godmode`, footer, `godmode_delegate`, and `godmode_control`;
- one active read-only Eye through public async RPC;
- disable and restoration.

Exit: Godmode reliably promotes/restores the Primary and completes one bounded Eye assignment.

### Shipped milestone — Hand and shared-checkout guard

- Hand registration and exact tool/model preflight;
- structured implementation assignments;
- Primary mutation blocking;
- stop, steer, completion reconciliation;
- Primary review guidance and acceptance checklist.

Exit: one bounded Hand can implement while the Primary remains the sole decision and acceptance authority.

### Shipped milestone — Scale and hardening

- Scale registration and review contracts;
- degraded-mode recovery;
- duplicate/late event hardening;
- full TUI toggle states;
- real integration matrix;
- documentation and release packaging.

Exit: Eye, Hand, and Scale operate through the complete Godmode workflow with deterministic toggle and cleanup behavior.

## 20. Acceptance criteria

The first stable release is ready when:

1. `/godmode` is the only Godmode slash command; each session starts by attempting default-on enablement after the ordinary tool baseline is initialized, and TUI `/godmode` directly toggles.
2. Startup or manual enablement selects an explicitly configured high-tier model/thinking level and disabling restores the prior state.
3. Enable fails transactionally when trust, configuration, models, authentication, faculty preflight, or required `pi-subagents` capabilities are unavailable; startup failure leaves the session running in off state and shows an actionable UI notification when available.
4. The Primary can launch only Eye, Hand, or Scale through the Godmode model-facing API.
5. Oracle, arbitrary agents, workflow scripts, nested delegation, schedules, worktrees, arbitrary cwd, and model/tool overrides are absent from that API.
6. A session-scoped capability ceiling independently enforces the faculty and tool boundary.
7. Eye and Scale are verified read-only; Hand is the only mutation-capable faculty.
8. Exactly one faculty can be active, including under concurrent tool calls and ambiguous lifecycle status.
9. Primary mutation tools are blocked while Hand is active, while `web_search`, `fetch_content`, and `get_search_content` remain available as documented read-only web tools; unknown tools remain blocked.
10. Faculties use fresh standalone assignments and escalate material decisions through native supervisor coordination.
11. After delegation, the Primary returns control instead of independently repeating or continuing the active Faculty's assignment.
12. Status, steering, stop, completion, lifecycle artifacts, and FleetView are supplied through documented `pi-subagents` behavior.
13. Godmode contains no child-process manager, custom cross-process transport, or private `pi-subagents` import.
14. Hand completion is presented as a handoff, never automatic acceptance.
15. The Primary inspects actual changes and independently runs required validation before reporting completion.
16. Stop-and-disable reaches terminal package status before restoring tools and the Primary model.
17. Unit, fake-owner integration, and real controlled-model tests cover enable, assignment, questions, mutation guard, completion, stop, disable, and restoration.
18. Documentation clearly describes the same-user trust boundary and the Primary’s final authority.
19. Configured faculty timeouts are soft deadlines with checkpoint notification, bounded supervisor extension, and a finite hard backstop.

## 21. Stable Primary guidance

The enabled Primary system guidance should remain concise and versioned:

> Godmode is active. You are the high-tier Primary and the sole planning, decision, orchestration, review, acceptance, and user-facing authority. Do not delegate authority or seek an oracle. Delegate bounded reconnaissance to Eye, implementation to Hand, and independent review to Scale. Only one Divine Faculty may be active.
>
> Give each Faculty a fresh standalone assignment with its goal, approved behavior, starting context, constraints, validation expectations, and escalation rules. Faculties execute; they do not decide product scope, architecture authority, security policy, version control, release actions, or acceptance. Answer material supervisor questions rather than allowing a Faculty to guess.
>
> Faculty runs complete asynchronously; automatic completion delivery is the default. After delegation, do not independently repeat or continue the Faculty's assigned work while it is active. Return control and wait for automatic completion, except to answer material supervisor questions or handle an explicit user interruption. Never call `godmode_control status` merely to check whether a queued or running faculty has finished. Do not call `subagent_wait` or poll with short timeouts. Use `godmode_control status` only when the user explicitly requests a snapshot, when recovering unknown session state, or when diagnosing a genuinely missing completion or inconsistent state. Repeated status calls waste tokens.
>
> A configured faculty timeout is a soft deadline, not an immediate kill. When deadline-pending status appears, let the Faculty checkpoint after its current tool and grant at most one bounded extension through godmode_control only when warranted; the finite hard deadline remains authoritative.
>
> Do not mutate the shared checkout while Hand is active. A Faculty handoff is evidence, not completion. After Hand returns, inspect the complete diff and all materially changed files, independently run required validation, require mandatory Scale review for feature/bugfix work unless a permitted waiver is recorded, resolve any Scale findings with bounded remediation and re-review, and only then report the task complete.

## 22. Shipped workflow, evidence, state, and doctor

This section is normative for the shipped workflow. The current package implements FR-1 through FR-12 through the normal-runtime `godmode_workflow` controller, append-only session ledger, constrained faculties, complete Primary inspection, interface-matched evidence matrix, mandatory Scale, bounded waivers, capped remediation, static diagnosis, previewed allowlisted apply/recovery, and safe legacy hint reconciliation. FR-13 package/documentation traceability is described below. The focused contracts are split into [`docs/WORKFLOW.md`](./docs/WORKFLOW.md), [`docs/EVIDENCE.md`](./docs/EVIDENCE.md), [`docs/STATE_AND_MEMORY.md`](./docs/STATE_AND_MEMORY.md), and [`docs/DOCTOR.md`](./docs/DOCTOR.md).

### 22.1 Functional requirements and phase boundaries

The workflow implementation must satisfy these numbered requirements; the current package ships the diagnostic and previewed-apply behavior described below:

- **FR-1 — Classification and packet:** classify each work item as feature, bugfix, refactor/maintenance, documentation/configuration, or test-only/tooling. Before Hand, the Primary-authored packet contains a minimal goal, numbered `functionalRequirements` entries with observable descriptions and applicable interfaces, non-goals, a short implementation-and-verification roadmap whose items map to requirements, acceptance checks, expected paths, and authority constraints. The normal-runtime `godmode_workflow` controller creates one fresh packet and stamps Primary-only audited transitions; replacement/reclassification is rejected except for the narrow blocked-only fresh-item supersession rule below. Feature adds a supported capability; bugfix corrects an incorrect or regressed behavior. Non-goals are not hidden acceptance failures; deferred ideas remain separate from the acceptance roadmap.
- **FR-2 — Canonical workflow state:** store one canonical workflow record in the session ledger, containing the current phase and exactly one status (`pending`, `implemented-unverified`, `verified`, `blocked`, or reasoned `waived`) for each roadmap item. Checklists, footers, dashboards, and plan checkboxes are derived views only. They cannot be a second status store or advance work without a ledger transition.
- **FR-3 — Red before Hand:** for executable feature/bugfix behavior, the Primary authors focused red tests before Hand starts and observes the intended failure, with command, result, requirement IDs, and controlled-environment evidence. A setup failure is not an intended red result.
- **FR-4 — Green without weakening:** Hand implements only the approved packet, keeps red tests meaningful and intact, makes them green, and escalates rather than broadening authority or weakening assertions.
- **FR-5 — Primary inspection:** after Hand, Primary inspects repository status, the complete relevant diff, every materially changed file, out-of-scope changes, test quality, and independent acceptance checks. The recorded checks must map one-to-one by exact command to every packet `acceptanceChecks` entry, each with mandatory evidence and a passing result; one passing check cannot mask another failure or omission.
- **FR-6 — Mandatory Scale:** a fresh-context Scale review is required before accepting every feature or bugfix. The only exceptions are a user-explicit waiver or a narrowly documented policy waiver with named scope, risk limit, owner/approver, and compensating independent evidence. Capacity or convenience is not a waiver.
- **FR-7 — Remediation:** blocker/fix-now Scale findings return the item to bounded remediation; `record-scale-review` requires a nonempty normalized checkout-relative `correctionScope` (or `remediationPaths`) that is a subset of packet `expectedPaths`, and correction Hand expected paths must be a nonempty subset of it. The Primary may issue one correction Hand assignment at a time, repeats affected inspection/evidence, and requires fresh Scale re-review. Optional findings become recorded residual risk or roadmap work.
- **FR-8 — Matching evidence:** acceptance evidence uses the real contract surface: browser UI through `surf-cli`; TUI through deterministic PTY/terminal capture; APIs through real controlled requests; CLIs through real executable invocation; libraries through a public consumer; persistence/migrations through disposable isolated fixtures; build/configuration through supported validation; and docs through link/render/example checks. The `interface-matched-v1` matrix records exactly one applicability decision per requirement/surface, requires passing evidence for applicable pairs, and rejects failed/blocked, stale, secret-bearing, or unsupported-substitution records. The Primary-only `record-evidence` action imports only explicit bounded passive artifacts and never executes invocation text.
- **FR-9 — Efficient state:** session custom ledger is authoritative active state; reconstruction selects the latest valid snapshot on the active Pi entry ancestry using mandatory session/work-item/schema identity, generation, predecessor, and timestamp metadata; custom entries are excluded from model context by default; only a selectively injected projection capped at 2 KiB UTF-8 and targeted at 512 estimated tokens is used; raw evidence is bounded details/artifact references; accepted runtime commits one bounded completion capsule atomically with its accepted record and matching latest capsule reference; and only reviewed durable knowledge is promoted into focused project docs. An ever-growing auto-injected `PROJECT_MEMORY.md` is forbidden.
- **FR-10 — Doctor discovery:** doctor performs bounded read-only discovery of project type/surfaces, existing tests/commands, browser/API/TUI/CLI verification needs, docs/config, gaps, and safety findings, and may propose an optional lightweight validation profile and durable guidance.
- **FR-11 — One command and safe apply:** evolve the single `/godmode` command so bare `/godmode` toggles in TUI and `/godmode doctor` is read-only. Exact `--apply`, `--replace`, `--confirm`, and `--recover` states provide bounded preview, named operations, explicit cryptographic token confirmation, conflict checks, owner-safe creation, replacement backup/recovery, and no silent overwrite; project writes are limited to `.godmode/validation-profile.json` and `docs/GODMODE_WORKFLOW.md`.
- **FR-12 — Safety and compatibility:** doctor/apply never execute arbitrary discovered commands, and legacy checklist/status/memory files are bounded untrusted hint sources whose bytes and canonical workflow state remain unchanged. Effectful apply/recovery require `trusted === true`, explicit `isIdle === true` or `idle === true`, and explicit `activeFaculty: null`; omitted, undefined, or non-null faculty proof denies. The registered command re-reads trust, idle, and `activeRun?.faculty` after `waitForIdle()` and supplies `activeFaculty: null` only from that post-wait proof. Replacement post-write failure automatically attempts verified atomic restoration; if restoration or cwd proof cannot be proven, it retains a bounded process-local recovery token and reports an explicit partial/error result. A pinned target proven installed and verified before cwd restoration failure is reported as applied, later operations are stopped, and the cwd warning is explicit. Recovery does not consume its token or backup until target bytes and cwd restoration are proven; failed recovery returns the same handle for retry until TTL, while an already-completed restore is safely finalizable on retry. All pinned operations use a synchronous process-global cwd guard shared by manager instances. Apply preserves the current same-user/non-sandbox, constrained faculty/model/tool, path, one-active-faculty, shared-checkout, public-API, and no-automatic-release contract.
- **FR-13 — Proportionate docs:** docs distinguish current runtime from target design, cross-link the focused contracts, include security/redaction/retention rules, and do not require heavyweight project memory or workflow documentation.

### 22.2 Classification, goal, and status gates

A feature or bugfix cannot skip from a request to Hand. The shipped gate sequence is:

```text
draft -> classified -> specified -> red-test-ready
red-test-ready -> red-test-observed | tdd-waived
red-test-observed | tdd-waived -> hand-running
hand-running -> hand-handoff -> primary-verifying
primary-verifying -> evidence-ready | remediation
evidence-ready -> scale-running -> review-passed
evidence-ready -> scale-waived
review-passed | scale-waived -> accepted
scale-running -> remediation (blocker/fix-now)
remediation -> hand-running
any active phase -> blocked
blocked -- distinct fresh work-item via `specify` --> red-test-ready
```

A recorded gate waiver leads to the gate-specific `tdd-waived` or `scale-waived` phase only; it does not mean accepted. Roadmap items separately progress from `pending` to `implemented-unverified` to `verified`, or become `blocked` or validly `waived`; Hand may report implementation, while only Primary records verification or waiver. All required roadmap items must be verified or validly waived before acceptance. `accepted` is set only by Primary after all applicable gates. The runtime mode/faculty lifecycle statuses in section 12 are operational metadata, not alternate workflow state. Unknown/conflicting state fails closed. Every phase or item-status transition records actor, timestamp, item, reason, and evidence/decision reference.

#### Blocked-packet supersession and recovery

A valid current record in `blocked` is the only record that can be superseded; `blocked` is not a same-item phase-recovery route. A Primary `specify` action may then author one fresh packet only when its `workItemId` is distinct from and absent from persisted active-branch history. The controller independently captures a bounded, accessor-free authority, reconstructs and validates the persisted active branch, requires the latest persisted authority to exactly match the current blocked runtime record, and checks every ledger identity before appending. Accessor-backed or changing runtime/persisted authority, an oversized branch, malformed or conflicting ledger state, absent/inconsistent persisted authority, unprovable lineage, a same-ID or historically reused ID, and any active, accepted, rejected, or otherwise non-blocked record fail closed. The append is accepted only after the active leaf exactly acknowledges the fresh snapshot and ancestry; failed pre-append proof or exact acknowledgement does not accept a replacement (and leaves the blocked runtime authority in place). The fresh packet starts at `red-test-ready`; prior blocked snapshots remain append-only inert history. Branch reconstruction and ordinary or forked lifecycle recovery consequently select the fresh item, with no same-item phase recovery or malformed-ledger repair.

### 22.3 TDD and test integrity

The shipped workflow controller records an observed intended red result without accepting caller-supplied actor, hash, phase, or history authority. It computes SHA-256 from the checkout, rejects setup/unrelated failures, and persists only after exact ledger acknowledgement. Before Hand spawn, Godmode records `hand-running`; an immutable red-test monitor watches the file and parent, and any targeted event is sticky even if bytes are restored. Hand admission verifies the canonical packet phase, requirement coverage, checkout-confined test path, SHA-256 content identity, meaningful assertion, and non-skipped/non-tautological test content. Assignment expected paths and acceptance checks may deliberately narrow, but may not expand, packet authority; the packet identifies the immutable test and the Hand assignment explicitly prohibits mutating it, whether or not that path is retained in the narrowed scope. Completion reconciliation records only an intact terminal Hand as `hand-handoff`; all failures or integrity compromise are `blocked`. After Hand, the Primary records complete status/diff/material-path inspection and independently passed checks before evidence-ready; independent check commands must exactly cover every packet acceptance check with mandatory evidence, and Scale admission includes the union of material and investigated out-of-scope paths as read-only context, persists scale-running before spawn, and only a trusted exact completed run can be reviewed. Passing review or a bounded waiver is required for acceptance; blocker/fix-now findings create capped path-bounded remediation that clears stale gate records for fresh inspection/review. A flawed fixture or test is escalated to Primary; it is not permission to dilute the gate.

A documentation-only work item may waive TDD when no executable behavior changes and a source test would not exercise the requested contract. Narrow waivers must state the inapplicable seam, reason, approving actor, date/scope, requirement IDs, and compensating interface-matched check/evidence. No blanket “docs” or “time pressure” waiver can silently cover feature/bugfix behavior. Primary inspection and mandatory Scale remain required gates.

### 22.4 Evidence, Scale, and acceptance

Evidence records map requirement IDs to the applicable interface, controlled inputs/environment, exact invocation or interaction, observed result, bounded imported artifact reference, Primary actor/timestamp, inspection fingerprint, fixed adapter identity/version, redaction/retention class, and pass/fail/blocked result. The current `interface-matched-v1` matrix requires all eight surfaces to be decided exactly once per requirement; applicable pairs need passing evidence while not-applicable pairs need a bounded reason and no pretending record. The controller never executes invocation text. The details and security rules are normative in [`docs/EVIDENCE.md`](./docs/EVIDENCE.md). Unit tests supplement but do not replace a required interface check.

Hand output is a handoff. Primary independently checks the real result and reads all materially changed files. Scale inspects the actual source/diff and evidence in fresh context, reports blocker/fix-now/optional findings, and never accepts. Feature/bugfix acceptance is forbidden without Scale or a permitted recorded waiver. After remediation, evidence and Scale review are rerun rather than overwritten. Only Primary records `accepted` and reports completion.

### 22.5 Ledger and token policy

The session custom ledger is authoritative active execution state but is excluded from model context by default. A short selectively injected projection contains only the current phase, exceptional roadmap-item statuses, goal, next gate, blockers/unresolved decisions, latest evidence outcomes, and a few artifact IDs; it is capped at 2 KiB UTF-8 and targets at most 512 estimated tokens. Reconstruct the latest valid snapshot only from the active Pi entry ancestry using mandatory identity, generation, predecessor, and timestamp metadata; keep bounded raw evidence details/references and a terminal completion capsule. Expire raw artifacts according to retention policy and promote only redacted durable cross-session facts into focused project docs. Explicit lifecycle cleanup removes currently held artifact references; expiry makes artifacts unusable, and crash leftovers defer to host OS temporary-file retention because automatic pathname deletion is not race-safe in this runtime. Never auto-inject an unbounded `PROJECT_MEMORY.md`, transcripts, full diffs, or evidence directories. See [`docs/STATE_AND_MEMORY.md`](./docs/STATE_AND_MEMORY.md).

Evidence, repository content, screenshots, HTML, terminal captures, requests/responses, and faculty output are untrusted. The bounded importer rejects authority artifacts containing credentials, tokens, cookies, private keys, `.env` payloads, binary/NUL data, or signed URLs rather than silently redacting proof. Accepted files are copied to owner-only OS-temp directories; the ledger/model context retains descriptors only. Use bounded excerpts and access-controlled artifact references; retain only for the configured review/incident period. A completion capsule preserves result and residual-risk pointers after raw details expire without becoming an automatic acceptance.

### 22.6 Doctor, previewed apply, and safe legacy reconciliation

The shipped command grammar is:

```text
/godmode                 # TUI toggle; outside TUI, bounded read-only state
/godmode doctor          # read-only readiness assessment
/godmode doctor --apply  # preview and one-time token; no write
/godmode doctor --apply --replace <allowed path>  # one exact replacement preview
/godmode doctor --apply --confirm <token>  # explicit trusted/idle/no-active-faculty apply
/godmode doctor --apply --recover <token>  # bounded replacement recovery
```

Doctor is read-only by default and does not toggle mode, write files, install packages, fetch the network, launch faculties, run tests/builds/migrations, execute binaries, or run any command discovered in project manifests. It statically and boundedly discovers project type and surfaces, tests and command declarations, likely browser/API/TUI/CLI verification needs, docs/config, gaps, and safety concerns. It labels facts as observed, inferred, or proposed and treats project instructions as untrusted data.

Apply is additive and opt-in: the first `--apply` command is a project-read-only preview showing a complete bounded proposed diff, named operations, target identities, candidate hints, digest, and one-time cryptographic token. Direct preview API access remains read-only even for an untrusted project; the registered command requires an affirmative trust method. Only explicit confirmation can create the exact allowlisted `.godmode/validation-profile.json` and/or `docs/GODMODE_WORKFLOW.md`; exact `--replace <path>` is required for an existing target. Effectful confirmation/recovery require affirmative trust, explicit idle proof, and explicit `activeFaculty: null`; missing/false trust, idle, or no-active-faculty proof is denial. Confirmation rechecks canonical root, no-follow parent/target identities and hashes before any write, uses exclusive owner-safe creation, and uses an owner-only OS-temp backup plus atomic replacement for replacement previews. If post-write sync or verification fails after replacement, apply automatically attempts atomic restore and verifies the original bytes before deleting the backup; if rollback or cwd restoration cannot be proven, it returns explicit partial/error status with accurate per-operation status, a bounded process-local recovery token, and retained backup. Successful replacement results offer expiring recovery. Recovery retains the same token and backup on every unproven rename, verification, or cwd-restoration failure, and consumes/removes them only after a verified restore; a retry can finalize bytes already restored before a failure, while an unrelated generated-target mismatch remains refused but retryable until TTL. Pinned operations are protected by a synchronous process-global cwd guard shared by all manager instances. Conflicts, races, and partial operations are explicit and never silently overwrite. Generated content is deterministic, bounded, redacted, and marks discovered commands/hints non-authoritative; no command, process, network, ledger, model, or faculty path is invoked. Recovery handles are in-memory and are not crash-persistent. Active inspection, evidence, and recovery references are explicitly cleaned through lifecycle ownership; expiry makes artifacts unusable, while crash leftovers defer to host OS temporary-file retention because automatic pathname deletion cannot be made race-safe with this runtime. Existing projects can begin with an ephemeral ledger and no heavyweight migration. Exact legacy files (`PROJECT_MEMORY.md`, `CHECKLIST.md`, `TODO.md`, `STATUS.md`, `.godmode/checklist.json`) are bounded no-follow untrusted hint sources; their bytes remain unchanged and no canonical status/phase/acceptance is imported. Full behavior and safety details are in [`docs/DOCTOR.md`](./docs/DOCTOR.md).

### 22.7 Shipped status and limitations

**FR-13 documentation/package contract:** README links to the normative SPEC and every focused document; package files include `docs/`; every packed relative link resolves; examples are bounded and non-networked; and docs label unsupported browser/HTTP surfaces and process-local recovery accurately. Local documentation/package checks inspect links, anchors, examples, generated guidance policy, terminology, and `npm pack --dry-run`-style file inclusion without lifecycle or network execution.

The current repository implements the runtime contract described in sections 6–18, including the bare `/godmode` command, exact doctor/apply grammar, bounded read-only diagnosis, previewed allowlisted apply/recovery, safe legacy hint reconciliation, and constrained faculties, subject to the existing tests and documented limitations. It also implements the normal-runtime `godmode_workflow` controller, structured packet requirements, append-acknowledged Primary lifecycle transitions, pre-Hand red-test/TDD admission, bounded assignment narrowing, sticky red-test monitoring, Hand integrity checks, complete Primary inspection, the all-surface interface evidence matrix and passive artifact importer, mandatory Scale acceptance/review, bounded Scale waivers, capped remediation, accepted-record completion capsules, bounded read-only stale-candidate detection, and FR-13 documentation/package checks. Repository controlled readiness checks do not claim browser or HTTP API evidence because those surfaces are not shipped.
