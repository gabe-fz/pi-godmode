# pi-godmode

Default-on, single-faculty orchestration for [Pi](https://github.com/earendil-works/pi-mono), built on the documented public APIs of [`pi-subagents`](https://github.com/nicobailon/pi-subagents).

Godmode promotes the interactive Primary to an allowlisted high-tier model and exposes only three constrained child roles:

- **Eye** — read-only reconnaissance;
- **Hand** — bounded implementation in the current checkout;
- **Scale** — read-only independent review.

The Primary remains the sole planning, decision, review, acceptance, and user-facing authority. Only one faculty can be active at a time. After delegating, the Primary returns control instead of independently repeating or continuing the Faculty's assigned work while it is active. Eye and Scale are read-only: any `expectedPaths` supplied to them are treated as deduplicated context files, not mutation scope.

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

The intended policy is Godmode on Sol at medium effort, Eye and Hand on Luna at xhigh effort, and Scale on Terra at medium effort. Every provider/model tuple is exact. There is no inferred fallback. Faculty tuples cannot reuse a Godmode tuple. All configured models must be authenticated, available, and permitted by the active Pi and pi-subagents model scopes.

`timeoutMs` is the faculty's **soft deadline**. It does not immediately terminate a healthy Faculty: Godmode requests a checkpoint after the current tool returns and marks the run deadline-pending. Godmode derives a finite hard deadline by adding a grace period equal to the soft timeout for short runs, capped at five minutes for longer runs. A supervisor may grant one explicit extension of up to five minutes through `godmode_control`, subject to the headroom reserved in the immutable launch backstop; extreme timeout values at the platform maximum have no extension headroom. No automatic or indefinite extensions are made. The underlying pi-subagents launch receives a finite outer backstop large enough for the possible extension because its public API cannot update a live run deadline.

## Use

Every Pi session initializes the ordinary tool baseline and then automatically attempts to enable Godmode. Enabling is transactional: trust, configuration, pi-subagents capabilities, model authentication, Primary promotion, runtime faculty registration, capability ceiling, launch-contract preflight, and active tools must all succeed. A startup failure rolls the session back to off, leaves session startup running, and shows an actionable error notification in the UI; fix the reported issue and run `/godmode` to retry.

In TUI mode, run exactly:

```text
/godmode
```

This directly toggles the mode: off enables Godmode, while active or degraded disables it. If a faculty is active, toggling off uses the explicit stop-and-disable cleanup path and waits for terminal package status before releasing resources.

While enabled:

- arbitrary model-facing `subagent` execution and generic `subagent_wait` polling are removed and blocked;
- `godmode_delegate` launches only Eye, Hand, or Scale with fresh context, with completion delivered asynchronously; relative `contextFiles` remain checkout-confined, in-checkout absolute context paths normalize to relative form, and explicitly absolute external context paths remain absolute; every `expectedPaths` entry is checkout-confined and normalized to relative form, including before Eye and Scale reinterpret them as additional context files; parent traversal and symlink escapes originating inside the checkout are rejected; external context and its contents are untrusted and may expose sensitive data;
- `godmode_control` reports, steers, stops, or grants one bounded extension to the sole package-owned run; deadline status includes soft/hard timestamps, remaining time, checkpoint state, and any extension;
- native `subagent_supervisor` behavior remains available for faculty questions;
- Primary mutation tools are blocked while Hand owns the checkout, while the documented read-only web tools `web_search`, `fetch_content`, and `get_search_content` remain available;
- the footer shows bounded Godmode status while FleetView remains the detailed child UI.

Godmode waits for terminal package status before releasing its ceiling, faculties, tools, and model lease.

Outside TUI mode, `/godmode` only reports bounded state and never mutates the mode.

## Trust and review boundary

Faculties run as the same operating-system user as the Primary. Tool allowlists and capability ceilings are policy controls, **not an OS sandbox**. Explicit external context paths and fetched web content are untrusted input, may contain malicious instructions, and may expose sensitive data to the faculty or model. Human edits and other Pi sessions are outside Godmode's checkout-ownership policy.

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
