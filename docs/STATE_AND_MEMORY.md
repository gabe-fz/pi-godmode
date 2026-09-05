# State, ledgers, and memory (FR-9)

> **Shipped behavior:** the session custom ledger, active-branch recovery, bounded projection, accepted completion capsule, packet/TDD records, interface-evidence matrix, read-only doctor, and previewed apply/recovery are implemented. Apply generates only the two exact allowlisted project files; legacy sources remain untrusted and unchanged. Apply previews, recovery handles, and temporary backups are process-local to the extension instance and are not crash-persistent. This design does not introduce a separate project ledger.

Godmode separates **active session execution state** from **durable project knowledge**. The distinction protects token budgets, prevents stale checklists from becoming authority, and limits sensitive evidence retention.

## Canonical sources

### Session custom ledger — authoritative active state

The session custom ledger is the authoritative source for the currently active work item and its execution state. It contains one current record per item with bounded fields such as:

- work-item ID, classification, minimal goal, requirement IDs, non-goals, and expected paths;
- one canonical workflow phase plus one canonical status for each requirement-linked roadmap item (see [`WORKFLOW.md`](./WORKFLOW.md));
- active faculty/run ID and lifecycle/deadline metadata when present;
- red-test result or explicit waiver reference;
- latest Hand handoff capsule;
- latest Primary inspection and interface-matched evidence-matrix summary;
- Scale verdict, finding dispositions, and waiver reference if any;
- unresolved decisions, blockers, residual risks, and next gate; and
- bounded artifact references and timestamps.

Custom ledger entries are **excluded from model context by default**. They may be selectively read or injected by the Primary or an approved workflow projection. A faculty report cannot create a second canonical status; the Primary reconciles it into the ledger.

The ledger must not become an unbounded event diary. Keep current facts and a bounded history of status changes needed for auditability. Superseded raw details are referenced, compacted, or expired according to retention policy.

### Latest branch snapshot

Keep one logically current bounded snapshot per branch. Because Pi session entries are append-only, a new custom entry supersedes the prior snapshot on that active branch; reconstruction selects the latest applicable entry rather than treating every snapshot as current or injecting an accumulating memory page.

Every snapshot must carry the session ID, work-item ID, workflow schema version, a monotonically increasing generation, the superseded snapshot entry ID (when one exists), and creation timestamp. Pi's immutable custom-entry `id`/`parentId` ancestry is the authoritative branch identity and ordering boundary: reconstruction considers only snapshots on `ctx.sessionManager.getBranch()`, then selects the highest valid generation whose supersession chain is consistent. A duplicate generation, missing claimed predecessor, cross-branch predecessor, or conflicting snapshot fails closed to `blocked`; timestamp alone never determines precedence. A new fork initially inherits its ancestor snapshot and appends its own successor before changing workflow state.

The bounded payload may additionally contain a sanitized diff/status fingerprint, current work-item phases and roadmap statuses, last accepted capsule reference, and known blockers. It is a recovery hint, not permission to accept stale work; the Primary compares it with the current checkout before use.

A blocked snapshot has one narrow supersession path: `godmode_workflow` may append a fresh packet only when persisted active-branch reconstruction independently proves that the current runtime record is the same valid `blocked` snapshot and the replacement has a distinct work-item ID absent from persisted history. The append creates a new generation-one snapshot for the fresh item; it does not rewrite or reuse the blocked record. Malformed entries, conflicting or absent authority, any non-blocked/active/terminal record, same-ID requests, and unprovable lineage fail closed without appending. Reconstruction then selects the fresh item while retaining prior blocked snapshots as inert append-only history.

A branch snapshot must not store full diffs, transcripts, command output, secrets, or every historical run. If no active work exists, the snapshot can be absent or a compact last-known summary.

### Raw evidence and artifacts

Raw evidence belongs outside the workflow ledger in bounded owner-only temporary artifacts governed by [`EVIDENCE.md`](./EVIDENCE.md), not in the active prompt. The shipped importer reads only explicit regular non-symlink checkout/approved-temp files, rejects secret-like authority evidence rather than silently redacting it, and persists only descriptors with provenance, hash, size, retention, and expiry. Invocation text is Primary-observed provenance and is never executed.

### Terminal completion capsule

At terminal completion, the accepted runtime appends one short completion capsule atomically with the accepted `WorkflowRecord`; create it from the fully gated accepted record before the single append acknowledgement. It contains:

```text
item + classification
final canonical workflow phase and roadmap-item outcomes
requirements and evidence outcomes
red-test/waiver reference
Scale verdict/waiver and finding disposition
changed-scope summary
residual risks, blocked checks, and next action
artifact references and timestamp
```

The capsule is a bounded handoff/recovery object. An accepted capsule has matching work-item, `phase: accepted`, `accepted: true`, and `latestCapsuleReference` identity; malformed or forged capsules fail closed. Raw artifacts and transcripts are never included. Retain it longer than raw details only when host policy permits and it remains redacted.

### Curated project knowledge

Promote knowledge across sessions only after the Primary reviews it for durability, usefulness, and sensitivity. Suitable destinations are focused project docs such as a validation profile, contributor workflow, architecture decision record, migration note, or security runbook. Each entry should explain scope and date and replace stale guidance rather than append a diary.

Do **not** create or auto-inject an ever-growing `PROJECT_MEMORY.md`. A large memory file becomes stale, costs tokens on every turn, mixes evidence with decisions, and encourages unreviewed repository content to act as authority. If a project already has such a file, treat it as untrusted, non-canonical input and migrate only a curated subset with explicit preview/approval as described in [`DOCTOR.md`](./DOCTOR.md).

## Token-efficient context policy

The implemented ledger/projection boundary and later workflow additions follow this bounded context budget:

1. Keep the full ledger and raw artifacts outside model context by default.
2. Inject only a short active projection when needed: current phase, roadmap exceptions, one-sentence goal, next gate, unresolved decision, latest evidence result, and a few artifact IDs.
3. Prefer current/latest values and compact capsules over historical entries; summarize before injecting.
4. Fetch raw details only when a user or Primary explicitly requests investigation and only within the access/redaction policy.
5. Inject the work specification and requirement IDs, not an entire session transcript.
6. On completion, remove the active projection and retain the bounded capsule; promote only curated durable knowledge.
7. At recovery, compare the ledger/capsule and latest branch snapshot with the actual repository state before resuming or accepting.

The serialized active projection has a deterministic hard cap of 2 KiB UTF-8 and should target at most 512 estimated model tokens. If required fields alone exceed 2 KiB, injection fails closed and reports `blocked` rather than silently dropping them. Otherwise truncation is surfaced and removes optional prose first while preserving phase, exceptional roadmap statuses, next gate, blockers, waiver references, and residual-risk pointers.

## Status integrity

The ledger's canonical workflow record is the only state authority: it contains one current phase and one current status per roadmap item. Derived checklists, UI footers, plan artifacts, dashboard counts, and faculty prose may render those fields but cannot write independent state. Hand may support an `implemented-unverified` transition through its handoff; only Primary can record `verified`, `waived`, or `accepted`. Every transition records who made it, why, and the evidence/decision reference. Unknown or conflicting state fails closed to `blocked` until the Primary reconciles it.

Session execution state expires with the session/retention policy unless promoted. Project knowledge persists only in reviewed docs. No state mechanism grants a faculty authority over product scope, security, release, or acceptance. Temporary inspection, evidence, and recovery directories use own prefixes and bounded read-only startup/shutdown stale-candidate detection with expiry/age checks and no-follow symlink handling. Active artifact references are explicitly cleaned; expiry makes artifacts unusable. Crash leftovers defer to host OS temporary-file retention because automatic pathname deletion cannot be made race-safe with this runtime.
