# Pi Godmode Build Specification

**Status:** Proposed
**Product:** `pi-godmode`
**Initial specification version:** 1

## 1. Summary

Pi Godmode is a default-on orchestration mode for Pi. At every session start, after the ordinary tool baseline is initialized, the current interactive session automatically attempts to become active on a configured high-tier model. The session retains responsibility for understanding requests, planning, decisions, user interaction, review, validation, and final acceptance.

The primary session delegates bounded execution through three specialized **Divine Faculties** backed by `pi-subagents`:

- **Eye** — read-only reconnaissance and codebase understanding;
- **Hand** — implementation in the active checkout; and
- **Scale** — independent review and validation.

Godmode is a policy and user-experience layer, not a child-process manager. `pi-subagents` owns child launch, model execution, supervisor communication, status, steering, stopping, lifecycle artifacts, and completion delivery. Godmode owns the mode toggle, primary-model lease, faculty definitions, delegation restrictions, single-active-faculty policy, and final-authority guidance.

Godmode deliberately does not use an advisory-oracle escalation flow. The high-tier primary session is the planning and judgment authority. Faculties execute bounded assignments and escalate unresolved decisions upward through the native `pi-subagents` supervisor channel.

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
/godmode
```

The command accepts no arguments. Non-whitespace arguments display:

```text
Usage: /godmode
```

At every `session_start`, Godmode first restores the ordinary active-tool baseline and then attempts transactional enablement. If startup enablement fails, the mode rolls back to off, session startup continues, and the UI receives an actionable error notification; after fixing the reported issue, run `/godmode` to retry.

In interactive TUI mode, `/godmode` directly toggles: off enables Godmode, while active or degraded disables it. Disabling never silently leaves an assignment running. When a faculty is active, the direct toggle-off uses the explicit stop-and-disable cleanup path and waits for terminal package status before restoring the previous Primary state.

Outside TUI mode, `/godmode` is read-only and reports the current bounded state. Mode mutation remains restricted to the interactive TUI command.

### 6.3 Footer

While enabled, Godmode shows one persistent status line:

```text
GODMODE ● idle
GODMODE ● Eye running
GODMODE ● Hand running
GODMODE ● Scale running
GODMODE ● decision requested
GODMODE ● result ready
GODMODE ● degraded
```

FleetView remains the detailed child-status surface. Godmode does not reproduce its transcript, timers, tokens, tools, or stop controls.

### 6.4 Primary behavior

While enabled, the Primary follows these rules:

- personally understand the request and inspect load-bearing source;
- retain all user-facing communication and material decisions;
- perform genuinely tiny, low-risk changes directly when delegation would add no value;
- delegate reconnaissance to Eye;
- delegate implementation to Hand;
- delegate independent post-implementation review to Scale when useful;
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
- paths may be checkout-relative or absolute when they resolve within the active checkout; absolute paths are normalized to checkout-relative form, while traversal, outside paths, and escaping symlinks are rejected;
- `hand` requires nonempty `expectedPaths` and `acceptanceChecks`;
- `eye` and `scale` reject mutation-oriented instructions; any supplied `expectedPaths` are safely reinterpreted as additional deduplicated `contextFiles` rather than mutation scope;
- the current Pi project must be trusted;
- Godmode must be active and healthy;
- no other faculty may be active;
- the resolved faculty launch contract must match its configured model, thinking, tools, and extension restrictions.

Absolute paths that resolve within the active checkout are normalized to checkout-relative form before assignment rendering. For Eye and Scale, `expectedPaths` are safely reinterpreted as additional deduplicated `contextFiles`; they do not grant read-only faculties mutation scope.

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
) -> GodmodeStatus
```

Because Godmode permits one active faculty, no child ID is model-selectable.

- `status` reconciles the remembered package run with public `pi-subagents` status.
- `steer` sends acknowledged guidance to the exact active run through public RPC.
- `stop` stops the exact active run and retains the package lifecycle result.

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
12. Deactivate the ordinary model-facing `subagent` execution and `subagent_wait` surfaces and activate `godmode_delegate` and `godmode_control` while retaining supervisor response support.
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
- Narrow read-only searches may remain available to the Primary when they can be classified safely.
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
8. Resolve any Scale findings against source evidence.
9. Launch at most one bounded correction Hand assignment at a time when fixes are required.
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
- Capability ceilings prevent the Primary from widening faculty identity, tools, or ambient extensions through model-visible parameters.
- Exact model configuration and strict preflight prevent silent fallback to the Primary model.
- Assignment text never grants version-control, publication, deployment, credential, or release authority.
- Godmode writes no credentials or environment values to its own status.
- Lifecycle and transcript sensitivity follow the documented `pi-subagents` artifact policy and are called out during installation.
- The Primary’s final inspection is the trust boundary for Hand output.

## 17. Package structure

Proposed implementation:

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
6. Scale independently reviews the resulting diff.
7. Primary runs validation and reports the final result.
8. Steering reaches a slow active faculty.
9. Stop-and-disable terminates the assignment and restores the prior model.
10. Authentication, unavailable model, and provider failure produce actionable terminal states without fallback.

## 19. Delivery phases

### Phase 1 — Toggle and Eye

- package scaffold;
- config and Primary model lease;
- public `pi-subagents` capability detection;
- runtime Eye registration and capability ceiling;
- `/godmode`, footer, `godmode_delegate`, and `godmode_control`;
- one active read-only Eye through public async RPC;
- disable and restoration.

Exit: Godmode reliably promotes/restores the Primary and completes one bounded Eye assignment.

### Phase 2 — Hand and shared-checkout guard

- Hand registration and exact tool/model preflight;
- structured implementation assignments;
- Primary mutation blocking;
- stop, steer, completion reconciliation;
- Primary review guidance and acceptance checklist.

Exit: one bounded Hand can implement while the Primary remains the sole decision and acceptance authority.

### Phase 3 — Scale and hardening

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
9. Primary mutation tools are blocked while Hand is active.
10. Faculties use fresh standalone assignments and escalate material decisions through native supervisor coordination.
11. After delegation, the Primary returns control instead of independently repeating or continuing the active Faculty's assignment.
12. Status, steering, stop, completion, lifecycle artifacts, and FleetView are supplied through documented `pi-subagents` behavior.
13. Godmode contains no child-process manager, custom cross-process transport, or private `pi-subagents` import.
14. Hand completion is presented as a handoff, never automatic acceptance.
15. The Primary inspects actual changes and independently runs required validation before reporting completion.
16. Stop-and-disable reaches terminal package status before restoring tools and the Primary model.
17. Unit, fake-owner integration, and real controlled-model tests cover enable, assignment, questions, mutation guard, completion, stop, disable, and restoration.
18. Documentation clearly describes the same-user trust boundary and the Primary’s final authority.

## 21. Stable Primary guidance

The enabled Primary system guidance should remain concise and versioned:

> Godmode is active. You are the high-tier Primary and the sole planning, decision, orchestration, review, acceptance, and user-facing authority. Do not delegate authority or seek an oracle. Delegate bounded reconnaissance to Eye, implementation to Hand, and independent review to Scale. Only one Divine Faculty may be active.
>
> Give each Faculty a fresh standalone assignment with its goal, approved behavior, starting context, constraints, validation expectations, and escalation rules. Faculties execute; they do not decide product scope, architecture authority, security policy, version control, release actions, or acceptance. Answer material supervisor questions rather than allowing a Faculty to guess.
>
> Faculty runs complete asynchronously; automatic completion delivery is the default. After delegation, do not independently repeat or continue the Faculty's assigned work while it is active. Return control and wait for automatic completion, except to answer material supervisor questions or handle an explicit user interruption. Never call `godmode_control status` merely to check whether a queued or running faculty has finished. Do not call `subagent_wait` or poll with short timeouts. Use `godmode_control status` only when the user explicitly requests a snapshot, when recovering unknown session state, or when diagnosing a genuinely missing completion or inconsistent state. Repeated status calls waste tokens.
>
> Do not mutate the shared checkout while Hand is active. A Faculty handoff is evidence, not completion. After Hand returns, inspect the complete diff and all materially changed files, independently run required validation, resolve any Scale findings, and only then report the task complete.
