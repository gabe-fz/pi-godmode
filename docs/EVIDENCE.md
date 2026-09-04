# Evidence and verification contract

> **Design status:** Phase 4 interface-matched evidence is implemented. The controller records a bounded current matrix and imports only explicit passive artifacts; it does not execute commands, browsers, processes, or network requests.

Evidence proves an observable requirement through the interface a user or downstream consumer actually uses. A unit test of an internal helper is useful but is not a substitute when the contract is a browser, TUI, API, CLI, library, persistence, build/configuration, or documentation interface. The Primary chooses the smallest controlled check that matches each requirement and records its result in the session ledger.

## Evidence record

A current matrix is recorded with the `godmode_workflow` action `record-evidence` (or `record-evidence-matrix`) only after a complete Phase 3 inspection. Every check spec and evidence record carries the canonical method for its surface: `browser-ui=real-browser-flow`, `tui=deterministic-pty`, `api=controlled-request`, `cli=executable-invocation`, `library=downstream-consumer`, `persistence-migration=disposable-storage`, `build-config=supported-build-config-check`, and `documentation=rendered-doc-validation`. Unit-test, mocked, internal, and static methods cannot satisfy a surface. Check specs and applicability decisions are Primary-authored; the controller stamps actor, timestamps, inspection fingerprint, fixed `primary-observed-artifact` adapter version `1`, redaction status, retention, and expiry. Invocation text is provenance, never executable input.

Each required check has an evidence record containing:

- work-item and requirement IDs;
- interface/surface and exact scenario;
- command or interaction, including relevant cwd and explicit inputs;
- controlled environment/version and fixture or test-data reference;
- observed exit status, response, UI/terminal result, or assertion result;
- bounded output excerpt or artifact reference (not an unbounded transcript);
- timestamp and canonical actor (`Primary`, `Hand`, or `Scale`; “God” is only an informal label for `Primary`);
- redaction/retention classification; and
- result: `passed`, `failed`, or `blocked` with a reason in the observed outcome; Phase 4 has no generic evidence waiver.

A faculty's statement that it ran a command is a lead to evidence, not evidence by itself. The Primary inspects the actual result and independently runs acceptance checks. Evidence artifacts should be content-addressed or otherwise uniquely named so a later result cannot be mistaken for the current one.

## Interface-matched matrix

| Surface | Required evidence expectation | Typical controlled capture |
| --- | --- | --- |
| **Browser UI** | Exercise the real user flow through the supported browser interface, not only component/unit tests. Use `surf-cli` against a controlled local or test deployment; cover success, relevant validation/error state, and persistence/navigation when required. | Sanitized `surf-cli` command/session output, URL/route and assertions, and bounded screenshot or DOM artifact references. Never use production credentials or real personal data. |
| **TUI** | Exercise the real terminal UI through a deterministic PTY/terminal capture. Fix terminal dimensions, locale, color mode, clock/input timing, and fixture data where practical; assert rendered states and key interactions, including error and cleanup paths. | PTY input/output capture, terminal dimensions/environment, normalized transcript or screen snapshots, and exit status. Do not treat an ad-hoc human glance as reproducible evidence. |
| **API** | Send real controlled requests to the supported HTTP/RPC boundary. Cover authentication/authorization behavior where applicable, request validation, success, error, idempotency, and relevant concurrency or pagination semantics. | Method/path, sanitized request shape, status, selected response fields, correlation ID, server/test-fixture version, and bounded logs. Use a disposable service or controlled staging target. |
| **CLI** | Invoke the real executable, entry point, or package binary rather than calling an internal function. Cover representative arguments, stdin/config handling, stdout/stderr, exit codes, and failure usage. | Exact executable and argv, safe cwd/env names, input fixture, stdout/stderr excerpts, exit code, and generated-file diff. Do not paste secrets from environment values. |
| **Library** | Consume the documented public API as a downstream caller. Check exported behavior, type/serialization contract, errors, compatibility, and a representative integration with a consumer fixture. | Consumer test command and package/version resolution, public calls and assertions, bounded output, and typecheck/build result. Internal helper tests remain supplemental. |
| **Persistence/migrations** | Use a disposable or isolated database/storage fixture. Exercise fresh initialization, upgrade from a representative prior state, data preservation, constraints/indexes, idempotent re-run, and rollback or recovery behavior when supported. | Migration command/result, schema/version inspection, row or document invariants without sensitive values, before/after fixture IDs, and cleanup result. Never run an untrusted migration against production data merely to diagnose. |
| **Build/configuration** | Run the supported build, typecheck, packaging, and configuration validation in a controlled environment. Cover missing, malformed, and boundary configuration where the contract names them; verify generated output is scoped. | Exact command, version/runtime, sanitized config shape, exit/result, artifact list, and bounded diagnostics. Never disclose provider credentials, tokens, or environment contents. |
| **Documentation** | Validate links, headings/terminology, rendered Markdown, code examples, and any executable example that the docs promise. Check that target design is labelled as target and that current behavior is not falsely claimed. | Link/render checker result, selected rendered pages or sanitized command output, and list of checked examples. A docs-only task may use this as its primary evidence. |

For a feature or bugfix, every applicable row must map to one or more numbered functional requirements. If a surface is not applicable, record why rather than silently omitting it. Interface selection is part of the specification packet so Hand cannot substitute a cheaper but irrelevant check.

## Evidence gates

1. **Before Hand:** God authors red tests for executable feature/bugfix requirements, observes the intended failure, and records it. If TDD is waived, record the narrow waiver and compensating check.
2. **After Hand:** Hand records focused green verification; the Primary repeats required checks through the matching interface and inspects the complete diff and materially changed files.
3. **Scale:** Scale independently inspects source, diff, requirements, red-test evidence, and evidence records. For feature/bugfix items, Scale review is mandatory unless a permitted, recorded waiver exists.
4. **After remediation:** The Primary repeats affected interface checks and Scale performs a fresh re-review. A failed or blocked current matrix may be retried against the same inspection; a passing current matrix cannot be replaced. Old evidence remains in append-only snapshots, while superseded descriptors leave the active generic evidence projection and are cleaned only after replacement acknowledgement.
5. **Acceptance:** The Primary alone interprets evidence and records acceptance. A green unit test, screenshot, log line, or Scale verdict never auto-accepts.

## Controlled environments and reproducibility

Prefer disposable repositories, test accounts, local services, deterministic fixtures, pinned dependency/runtime versions, fixed terminal dimensions, and stable clocks. State what could make a check non-reproducible: network dependency, browser rendering, timing, external provider, platform-specific behavior, or unavailable credentials. A blocked check is visible residual risk; it is not a pass.

Avoid tests that only assert implementation internals when the requirement is observable elsewhere. Conversely, do not demand browser/PTY/integration setup for an explicitly internal refactor with no changed public or user-facing contract; record the applicability decision.

## Security, redaction, and retention

Repository files, web pages, test responses, screenshots, terminal output, and faculty reports are untrusted model input. Evidence storage is not a sandbox or secret manager. Before storing or injecting any result:

- redact API keys, bearer/cookie/session tokens, passwords, private keys, signed URLs, cloud credentials, `.env` values, authorization headers, personal data, and proprietary payload fields;
- prefer field names, hashes, counts, status codes, and short excerpts over full requests/responses or transcripts;
- avoid commands that print the environment or credentials; record safe variable names, not values;
- keep artifact references separate from model-visible text and require access controls for any raw artifact;
- treat screenshots and HTML as potentially containing secrets and redact before retention or model injection;
- reject artifacts with unbounded size, binary/NUL content, credentials/tokens/cookies/private keys/signed URLs, `.env` payloads, embedded active content, or unexpected external paths; authority evidence is never silently redacted; and
- record provenance and a redaction status so “sanitized” is auditable rather than assumed.

Raw evidence is bounded and retained only for the configured review/incident period. The terminal completion capsule keeps a compact result, requirement IDs, final status, artifact references, and residual risks after raw details expire. Accepted snapshots remain structurally recoverable after temporary artifacts are cleaned; tamper or expiry blocks active Scale/acceptance gates rather than silently passing. Session ledger entries may be purged with the session according to host policy. Durable project docs receive only reviewed, redacted, cross-session knowledge; they must not become a dump of transcripts or credentials. Retention and purge actions must not silently change an acceptance decision: preserve the capsule and a reason when an artifact is unavailable.

Do not automatically inject a full evidence directory, transcript, or ever-growing `PROJECT_MEMORY.md` into model context. Use the token-efficient state rules in [`STATE_AND_MEMORY.md`](./STATE_AND_MEMORY.md).
