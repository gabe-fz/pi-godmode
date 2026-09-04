# pi-godmode

Default-on, single-faculty orchestration for [Pi](https://github.com/earendil-works/pi-mono), built on the documented public APIs of [`pi-subagents`](https://github.com/nicobailon/pi-subagents).

Godmode exposes three constrained faculties:

- **Eye** — read-only reconnaissance;
- **Hand** — bounded implementation; and
- **Scale** — independent read-only review.

The Primary remains the sole authority for intent, decisions, orchestration, review, acceptance, and user communication. The shipped workflow includes bounded, preview-first doctor apply with safe legacy hint reconciliation, mandatory Scale review, red-test gates, interface-matched evidence, redaction, and retention controls.

## Documentation map

- [`SPEC.md`](./SPEC.md) — normative product/runtime-security contract and implemented workflow/apply requirements.
- [`docs/WORKFLOW.md`](./docs/WORKFLOW.md) — spec-driven TDD, evidence gates, mandatory Scale review, remediation, and acceptance.
- [`docs/EVIDENCE.md`](./docs/EVIDENCE.md) — interface-matched evidence expectations and evidence security, redaction, and retention.
- [`docs/STATE_AND_MEMORY.md`](./docs/STATE_AND_MEMORY.md) — canonical workflow state, session ledgers, branch snapshots, and token-budget rules.
- [`docs/DOCTOR.md`](./docs/DOCTOR.md) — bounded doctor diagnosis, previewed apply/recovery, and legacy hint safety.
- [`docs/BASELINE.md`](./docs/BASELINE.md) — compatibility baseline and bounded validation record.

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
    "eye": { "provider": "openai-codex", "model": "gpt-5.6-luna", "thinking": "xhigh", "timeoutMs": 900000 },
    "hand": { "provider": "openai-codex", "model": "gpt-5.6-luna", "thinking": "xhigh", "timeoutMs": 1800000 },
    "scale": { "provider": "openai-codex", "model": "gpt-5.6-terra", "thinking": "medium", "timeoutMs": 900000 }
  }
}
```

Provider/model tuples are exact; there is no inferred fallback. Faculty tuples cannot reuse a Godmode tuple. Models must be authenticated, available, and permitted by the active Pi and pi-subagents scopes. A faculty timeout is a soft deadline with a bounded hard backstop, not an indefinite extension.

## Use today

There is one Godmode command. In the TUI, bare `/godmode` toggles the mode; outside the TUI it reports bounded state without mutating the mode. Startup attempts transactional default-on enablement after the ordinary tool baseline is initialized. A failure leaves the session running with Godmode off and reports how to retry.

While enabled, arbitrary `subagent` and `subagent_wait` surfaces are replaced by `godmode_delegate` and `godmode_control`. Only one faculty may be active. Eye and Scale are read-only; Hand is the only mutation-capable faculty, and Primary mutation is guarded while Hand owns the shared checkout. Faculty runs complete asynchronously through pi-subagents. A handoff is evidence, not acceptance.

`/godmode doctor` performs a bounded synchronous static assessment in every host mode. It never toggles, waits, delegates, executes discovered commands, accesses the network, or writes project files. `/godmode doctor --apply` returns a read-only preview and one-time token; the registered command requires affirmative project trust (missing trust denies), while only explicit `--confirm <token>` can write the two exact allowlisted targets after affirmative trust, explicit host idle proof, and an explicit `activeFaculty: null` proof (missing/false proofs deny). Exact `--replace <path>` previews provide owner-only backup and one-time process-local recovery; post-write verification failures automatically attempt verified rollback before retaining a recovery handle. See [`docs/DOCTOR.md`](./docs/DOCTOR.md).

## Trust boundary

Faculties run as the same operating-system user as the Primary. Tool allowlists and capability ceilings are policy controls, not an OS sandbox. The project, explicit external context, fetched web content, child output, and lifecycle artifacts are untrusted input and may expose sensitive data. Godmode never commits, pushes, opens a PR, releases, or deploys automatically. Review the pi-subagents artifact policy for storage and retention details.

## Development (current runtime)

```bash
npm install
npm run typecheck
npm test
```

The executable runtime and security contract remain in [`SPEC.md`](./SPEC.md); diagnosis and previewed apply/recovery are implemented without automatic command execution or legacy-file mutation. Active inspection, evidence, and recovery artifacts are explicitly cleaned through their held lifecycle references; expiry makes an artifact unusable even if its bytes remain. Crash leftovers defer to host OS temporary-file retention because automatic pathname deletion cannot be made race-safe with this runtime. Recovery handles are process-local and are not crash-persistent. Repository readiness checks use controlled local TUI-handler, package-consumer, disposable-session, doctor/apply, build/config, and docs/package checks; browser UI and HTTP API are not applicable because this package ships neither.

**FR-13 package/documentation contract:** packed contents include `README.md`, `SPEC.md`, `docs/`, source, and license; all shipped relative links resolve, examples are bounded/non-networked, and docs distinguish shipped behavior from proposals.
