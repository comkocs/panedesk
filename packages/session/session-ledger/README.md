---
description: "Durable call and lifecycle ledger service definitions."
kind: "package-reference"
---

# @panedesk/dsh-session-ledger

English | [中文](README.zh.md)

## Summary

Durable call and lifecycle accounting. The package exposes `SessionLedger`, public types, and the local `JournalSessionLedger` provider. The full service owns model-stream accounting independently of the optional cache plugin.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Import public types from the package entry. The package is Host-only and does not provide a browser entry. The `/messages` plugin registers only `messageLedger`, without `sessionLedger` or run, call, and tool accounting hooks. Its optional storage and lock settings match the full provider, and `nodeId()` resolves the same persisted `ledger/v1/node-id`. The message-only entry does not enable call accounting; compose the full provider separately when calls must be recorded.

`SessionLedger` installs one `llm/stream` listener per instance. It commits call intent before adapter dispatch, retains partial sidecars and observed usage through cancellation or failure, and settles the same physical call once. Logical requests, retries, backoff, exact reference pricing and wait attribution remain ledger-owned. Missing usage stays missing, not zero. Settlement failures block subsequent calls in the affected session.

`registerCallContributor(contributor)` accepts one optional cache contributor and returns an idempotent disposer. A second live registration rejects, including the same object twice. Register through the contributing plugin's effect; unloading removes future contributions while prepared calls retain their captured contribution until cleanup. Contributions freeze cache evidence before start, append breakpoints and request sidecars after start, acquire admission before dispatch, update terminal cache evidence before pricing, and persist cache observations after settlement. Neither registration order nor persisted-row lookup decides ownership.

Providers accept `Config.waitTools` and implement `registerWaitTool(name, category)` for trusted runtime classifications (`sleep`, `external-marker`, `subagent`). Runtime registrations override configured defaults; conflicting live categories reject, and the idempotent disposer releases only its registration. Unregistered tools remain `unclassified`; model output never defines a category.

`appendArtifact` writes restricted `partial-response` or `keepalive-request` JSON fragments under ledger-owned paths. `(callId, kind, seq)` identifies exact UTF-8 content bytes: equal replays return `existing`, unequal bytes return `conflict` without overwriting. Sequences start at zero and remain contiguous. Success follows file and required directory synchronization. `finishArtifact` verifies the last fragment and durably closes the stream; later new fragments reject, while exact replays remain idempotent. `LedgerCallFinish.artifacts` carries the returned references, not raw content. Fragment references and relative paths hashed into tail-recovery event IDs use `/` separators on every platform; reads and replays preserve the persisted reference format.

The provider owns transient stream positions and closure state. Each process scans a stream before using its hints; under the cross-process writer lock, subsequent appends check only that the previous sequence directory exists and the proposed one does not. A mismatch requires a complete scan and refreshes both hints. Old-sequence retries read and synchronize only that sequence. Streams belong to one call writer; foreign closures are observed on initial or fallback scans, not enumerated on every append. Stream scans, snapshots, queries and node imports reject fragments beyond a closure rather than silently exporting them. No hint replaces durable records or changes the file layout.

Call-accounting identities, call-event filenames, and artifact filenames use independent cryptographic version 4 UUIDs with 122 random bits; they do not consume the process-wide UUID function. Run and message identities keep their existing generators.

`JournalSessionLedger.messages()` stores body-free `message/state` facts in `ledger/messages/v1/<nodeId>/events/<UTC-date>/`, independently of the unchanged call namespace `ledger/v1/`. Message envelopes start at `schemaVersion: 1`; human origins may have no Session or run. Event identities derive from node, message, state version, and transition. A native writer lock serializes unique state versions; equal replays synchronize and acknowledge existing bytes, unequal replays reject. Each append creates a restricted checksummed JSONL segment and fsyncs it and its directory. Interrupted tails remain untouched, later writes use new segments, and reads report incomplete storage rather than hiding tails or corruption. Message bodies are rejected.

Call journals share a process-local view by real node directory, lock-file identity and record-size limit; the last service owner releases the view. Legacy UUID-named one-fact files are immutable and are not restatted after synchronization. Under the unchanged writer lock, refresh reads only new files and appended bytes, synchronizing them before use. Each process appends checksummed frames to its own UTC-day segment and synchronizes every fact; new segments also synchronize their directory. Failed appends abandon the segment, preserving interrupted tails. Replays synchronize the matching segment. Call and run settlement and sidecar start validation use the locked index. Call wait settlement, tool run selection and unbound attribution use keyed facts; ambiguous or conflicting selections retain full projection semantics. Snapshots reuse synchronized facts without changing projection semantics or the persisted, scan-order watermark algorithm; write acknowledgements compute and cache that same watermark on first access, pinned to their transaction even after later writes or service disposal. Unread acknowledgements retain only segment mark references and lengths, not copied facts; new facts invalidate the current view's watermark cache. One-fact files and multi-frame segments remain mutually readable.

Storage layout: each ledger root retains `writer.lock` beside its node identity or event directories, never on a data segment. Linux and macOS keep their existing descriptor flock, inode checks and retry loop. Only win32 opens the dedicated file with exclusive sharing; `EBUSY`/`EPERM` retry with backoff from `lockRetryMs` to 40 ms, bounded by `lockTimeoutMs`, then report `EAGAIN` with only the lock filename. Lock contents are never read or written; close or process exit releases ownership. Do not remove or replace lock files.

Directory synchronization tolerates only `EPERM`, `EISDIR` and `EINVAL` from opening or flushing directory handles on Windows. File writes, file synchronization, directory close failures and every non-Windows failure still propagate; Windows does not gain a guarantee that unsupported directory metadata synchronization completed.

`queryMessages` folds all versions before filtering current state, class, source/target Session and half-open creation time; state times preserve the first observation, including first injection after interrupted turns. Unanswered handoffs include replies and closed-target pending messages, exclude any response, and omit terminal outcomes unless explicitly requested. Projection cursors identify the last message; journal cursors identify the last event. `exportMessages` emits a schema-versioned integrity header even for empty results. `querySessions` joins calls and messages by both participating Session IDs, retaining unassigned human-origin messages separately. It combines independently locked reads, not an atomic cross-namespace checkpoint; messages never enter call totals.

<a id="model-experience"></a>
## Model Experience

### Call accounting

#### What the model sees

`src/index.ts` registers no tools, prompts, or messages, so the model receives no content from this package.

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
