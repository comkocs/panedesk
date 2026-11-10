---
description: "Durable call and lifecycle ledger service definitions."
kind: "package-reference"
---

# @panedesk/dsh-session-ledger

English | [中文](README.zh.md)

## Summary

Durable call and lifecycle accounting. The package exposes `SessionLedger`, public types, and the local `JournalSessionLedger` provider. The full service owns model-stream accounting independently of the optional cache plugin.

Activity producers may append `activity/start` and `activity/end` auxiliary facts with task and operation identities, category, script tag, observed timing and confirmed newly created paths. They remain event rows, never billable model calls. The activity service owns classification and task aggregation. Readers predating these event kinds report unknown journal facts as incomplete; current readers retain existing call and run facts unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Import public types and `includeDescendantSessions` from the package entry. The helper extends a caller-owned session set with transitive descendants from call and run parent links; event rows add no links. The package is Host-only and does not provide a browser entry. The `/messages` plugin registers only `messageLedger`, without `sessionLedger` or run, call, and tool accounting hooks. Its optional storage and lock settings match the full provider, and `nodeId()` resolves the same persisted `ledger/v1/node-id`. The message-only entry does not enable call accounting; compose the full provider separately when calls must be recorded.

`SessionLedger` installs one `llm/stream` listener per instance. It commits call intent before adapter dispatch, retains partial sidecars and observed usage through cancellation or failure, and settles the same physical call once. Logical requests, retries, backoff, exact reference pricing and wait attribution remain ledger-owned. Missing usage stays missing, not zero. Settlement failures block subsequent calls in the affected session. Conversation starts retain the exact Session `requestHeaderSeq` when available; auxiliary calls and older facts omit it. This association does not delay or reorder the durable intent before dispatch.

`registerCallContributor(contributor)` accepts one optional cache contributor and returns an idempotent disposer. A second live registration rejects, including the same object twice. Register through the contributing plugin's effect; unloading removes future contributions while prepared calls retain their captured contribution until cleanup. Contributions freeze cache evidence before start, append breakpoints and request sidecars after start, acquire admission before dispatch, update terminal cache evidence before pricing, and persist cache observations after settlement. Neither registration order nor persisted-row lookup decides ownership.

`registerCompactionOwner()` reserves compaction-event production for one plugin and returns an idempotent disposer. Concurrent owners reject. While registered, call accounting still records every physical summarization request and updates session compaction times, but does not append a second compaction fact. Without an owner, summary observations remain ledger-owned. Ownership follows explicit registration, not event timing. A rejected duplicate leaves no journal record; reopening the ledger clears the old process-local failure without rewriting committed facts.

Providers accept `Config.waitTools` and implement `registerWaitTool(name, category)` for trusted runtime classifications (`sleep`, `external-marker`, `subagent`). Runtime registrations override configured defaults; conflicting live categories reject, and the idempotent disposer releases only its registration. Unregistered tools remain `unclassified`; model output never defines a category.

`appendArtifact` writes restricted `partial-response` or `keepalive-request` JSON fragments under ledger-owned paths. `(callId, kind, seq)` identifies exact UTF-8 content bytes: equal replays return `existing`, unequal bytes return `conflict` without overwriting. Sequences start at zero and remain contiguous. Success follows file and required directory synchronization. `finishArtifact` verifies the last fragment and durably closes the stream; later new fragments reject, while exact replays remain idempotent. `LedgerCallFinish.artifacts` carries the returned references, not raw content. New fragment references and relative paths hashed into tail-recovery event IDs use `/` separators on every platform. Closure comparisons accept legacy `\` separators without rewriting stored records; event reads and exports preserve the original references. Tail recovery recognizes event IDs hashed from either separator form and adds no alert when either is already present.

The provider owns transient stream positions and closure state. Each process scans a stream before using its hints; under the cross-process writer lock, subsequent appends check only that the previous sequence directory exists and the proposed one does not. A mismatch requires a complete scan and refreshes both hints. Old-sequence retries read and synchronize only that sequence. Streams belong to one call writer; foreign closures are observed on initial or fallback scans, not enumerated on every append. Stream scans, snapshots, queries and node imports reject fragments beyond a closure. Keyed hot readers validate only calls identified by their returned facts: waits use optional `callId` fields, latest-start uses the selected start's `callId`, and open-runs normally returns run starts without call IDs and validates no streams. Facts without a call ID require no stream validation; ambiguous or conflicting selections validate every call ID in their full-projection facts. These readers locate `artifacts/<digest(callId)>` directly without enumerating unrelated calls. Unrelated closure violations do not block hot reads; full readers still reject them. Decoded closures are cached in the shared view, but selected directory entries and closure file identities are checked under the writer lock; unchanged closures require no additional file-content reads. No hint replaces durable records or changes the file layout.

Call-accounting identities, call-event filenames, and artifact filenames use independent cryptographic version 4 UUIDs with 122 random bits; they do not consume the process-wide UUID function. Run and message identities keep their existing generators.

`JournalSessionLedger.messages()` stores body-free `message/state` facts in `ledger/messages/v1/<nodeId>/events/<UTC-date>/`, independently of the unchanged call namespace `ledger/v1/`. Message envelopes start at `schemaVersion: 1`; human origins may have no Session or run. Event identities derive from node, message, state version, and transition. A native writer lock serializes unique state versions; equal replays synchronize and acknowledge existing bytes, unequal replays reject. Each append creates a restricted checksummed JSONL segment and fsyncs it and its directory. Interrupted tails remain untouched, later writes use new segments, and reads report incomplete storage rather than hiding tails or corruption. Message bodies are rejected.

Call journals share a process-local view by real node directory, lock-file identity and record-size limit; the last service owner releases the view. Legacy UUID-named one-fact files are immutable and are not restatted after synchronization. Under the unchanged writer lock, refresh reads only new files and appended bytes, synchronizing them before use. Each process appends call and non-call facts to its own UTC-day segment. Non-call appends retain their process-wide UUID consumption independently of storage filenames; segment names use the independent cryptographic generator, and event identities remain unchanged. Every fact is synchronized, and new files also synchronize their directory. Failed appends abandon the segment, preserving interrupted tails. Replays synchronize the matching segment. Call and run settlement and sidecar start validation use the locked index. Call wait settlement, tool run selection and unbound attribution use keyed facts; ambiguous or conflicting selections retain full projection semantics. Snapshots incrementally fold newly synchronized call, run and auxiliary facts into view-owned rows; descendant traversal and run wait aggregation use keyed adjacency and membership indexes. Conflicts retain the full-fold fallback, and returned rows are detached. Reads still validate all artifact closures. Snapshots reuse synchronized facts without changing projection semantics or the persisted, scan-order watermark algorithm; write acknowledgements compute and cache that same watermark on first access, pinned to their transaction even after later writes or service disposal. Unread acknowledgements retain only segment mark references and lengths, not copied facts; new facts invalidate the current view's watermark cache. One-fact files and multi-frame segments remain mutually readable.

Storage layout: each ledger root retains `writer.lock` beside its node identity or event directories, never on a data segment. Both providers default `lockTimeoutMs` to 30000 and `lockRetryMs` to 10; contention retries until the timeout, then throws `LedgerUnavailableError`. Linux and macOS keep their existing descriptor flock, inode checks and retry loop. Only win32 opens the dedicated file with exclusive sharing; `EBUSY`/`EPERM` retry with backoff from `lockRetryMs` to 40 ms, bounded by `lockTimeoutMs`, then report `EAGAIN` with only the lock filename. After acquisition, the owner retains its original acquisition time and identity in memory. An unreferenced timer publishes bounded diagnostic metadata after 5 ms of ownership; earlier release cancels publication without any diagnostic write. Release clears metadata only if publication was attempted, before closing the locked descriptor. Synchronous publication and cleanup cannot interleave. Shorter waiter timeouts or delayed owner scheduling can omit metadata; diagnostics do not add an fsync or authorize lock theft. The full ledger service retains its immutable process start and boot identities across acquisitions; timeout readers still verify the observed owner afresh. Linux timeouts attach the PID, acquisition time and elapsed ownership only when process start, boot identity and the kernel lock owner match a stable metadata read. Missing, stale or unreadable identities omit the attachment, including Windows exclusive-share reads. Close or process exit releases ownership. Do not remove or replace lock files.

Directory synchronization tolerates only `EPERM`, `EISDIR` and `EINVAL` from opening or flushing directory handles on Windows. File writes, file synchronization, directory close failures and every non-Windows failure still propagate; Windows does not gain a guarantee that unsupported directory metadata synchronization completed.

`queryMessages` folds all versions before filtering current state, class, source/target Session and half-open creation time; state times preserve the first observation, including first injection after interrupted turns. Unanswered handoffs include replies and closed-target pending messages, exclude any response, and omit terminal outcomes unless explicitly requested. Projection cursors identify the last message; journal cursors identify the last event. `exportMessages` emits a schema-versioned integrity header even for empty results. `querySessions` joins calls and messages by both participating Session IDs, retaining unassigned human-origin messages separately. It combines independently locked reads, not an atomic cross-namespace checkpoint; messages never enter call totals.

<a id="model-experience"></a>
## Model Experience

### Call accounting

#### What the model sees

`src/index.ts` registers no tools, prompts, or messages. A child model call stopped by writer-lock contention reports `LEDGER_LOCK_TIMEOUT` through the existing subagent failure result and parent notice, with an actionable busy-ledger diagnostic.

#### Token effect

Accounting observes model requests without dispatching additional requests or adding input or output tokens.

#### KV Cache effect

The ledger does not modify request prefixes or create or refresh cache entries. Optional contributors own cache policy and admission.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Reference costs require observed usage and an exact supported price key. Unknown counters, tiers and prices remain explicit coverage gaps; the ledger does not infer provider billing or compose application profiles.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
