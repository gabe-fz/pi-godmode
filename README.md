# pi-godmode

Opt-in, single-faculty orchestration for [Pi](https://github.com/earendil-works/pi-mono), built on the documented public APIs of [`pi-subagents`](https://github.com/nicobailon/pi-subagents).

Godmode promotes the interactive Primary to an allowlisted high-tier model and exposes only three constrained child roles:

- **Eye** — read-only reconnaissance;
- **Hand** — bounded implementation in the current checkout;
- **Scale** — read-only independent review.

The Primary remains the sole planning, decision, review, acceptance, and user-facing authority. Only one faculty can be active at a time.

## Install

```bash
pi install npm:pi-subagents
pi install npm:pi-godmode
```

Restart Pi after installing both packages. They must be loaded in the same parent process. `pi-godmode` requires `pi-subagents ^0.58.0` and checks the required RPC capabilities whenever Godmode is enabled.

## Configure

Create `${PI_CODING_AGENT_DIR:-~/.pi/agent}/godmode/config.json`:

```json
{
  "schemaVersion": 1,
  "nucleusPolicy": {
    "allowedModels": [
      { "provider": "openai-codex", "model": "HIGH_TIER_MODEL" }
    ],
    "minimumThinking": "high"
  },
  "faculties": {
    "eye": {
      "provider": "openai-codex",
      "model": "ECONOMICAL_READ_MODEL",
      "thinking": "low",
      "timeoutMs": 900000
    },
    "hand": {
      "provider": "openai-codex",
      "model": "ECONOMICAL_WRITE_MODEL",
      "thinking": "medium",
      "timeoutMs": 1800000
    },
    "scale": {
      "provider": "openai-codex",
      "model": "ECONOMICAL_REVIEW_MODEL",
      "thinking": "medium",
      "timeoutMs": 900000
    }
  }
}
```

Every provider/model tuple is exact. There is no inferred fallback. Faculty tuples cannot reuse a Nucleus tuple. All configured models must be authenticated, available, and permitted by the active Pi and pi-subagents model scopes.

## Use

Run exactly:

```text
/godmode
```

The TUI opens a toggle dialog. Enabling is transactional: trust, configuration, pi-subagents capabilities, model authentication, Primary promotion, runtime faculty registration, capability ceiling, launch-contract preflight, and active tools must all succeed. A failure rolls the session back.

While enabled:

- arbitrary model-facing `subagent` execution is removed and blocked;
- `godmode_delegate` launches only Eye, Hand, or Scale with fresh context;
- `godmode_control` reports, steers, or stops the sole package-owned run;
- native `subagent_supervisor` behavior remains available for faculty questions;
- Primary mutation tools are blocked while Hand owns the checkout;
- the footer shows bounded Godmode status while FleetView remains the detailed child UI.

Disabling with active work requires the explicit **Stop faculty and disable** action. Godmode waits for terminal package status before releasing its ceiling, faculties, tools, and model lease.

Outside TUI mode, `/godmode` only reports state and never mutates the mode.

## Trust and review boundary

Faculties run as the same operating-system user as the Primary. Tool allowlists and capability ceilings are policy controls, **not an OS sandbox**. Human edits and other Pi sessions are outside Godmode's checkout-ownership policy.

`pi-subagents` owns child processes, control transport, FleetView, lifecycle artifacts, transcripts, and completion delivery. Those artifacts can contain sensitive repository content; review the pi-subagents artifact policy for storage and retention details.

A Hand result is evidence, not acceptance. Before reporting completion, the Primary must inspect repository status and the complete relevant diff, read every materially changed file, investigate out-of-scope changes, and independently run required acceptance checks. Godmode never commits, pushes, opens a PR, releases, or deploys automatically.

## Development

```bash
npm install
npm run typecheck
npm test
```

The test suite covers strict configuration, model/tool leases, assignment/path validation, faculty contracts, capability/preflight verification, RPC envelopes, single-slot concurrency, attention/steering, completion correlation, degraded state, stop ordering, cleanup, restoration, and the shared-checkout mutation guard.

See [`SPEC.md`](./SPEC.md) for the complete product and security contract.
