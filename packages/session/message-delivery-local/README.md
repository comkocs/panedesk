---
description: "Private local file mailboxes and lease-backed node registrations."
kind: "package-reference"
---

# @panedesk/dsh-message-delivery-local

English | [中文](README.zh.md)

## Summary

Local file mailboxes live below the product home at `messages/nodes/<nodeId>`. The plugin registers already-leased Agents, publishes runtime busy/idle/closing observations, and removes their registrations after disposal. Session write leases remain authoritative; registration never acquires or steals a lease. See [Session persistence](../../../docs/subsystems/persistence.md).

## Table of Contents

- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="dev-note"></a>
## Dev Note

Configuration optionally supplies `nodeId`; otherwise startup resolves the persisted identity through `messageLedger.nodeId()` when that service is present, or through `sessionLedger.nodeId()` when it is absent. An unavailable identity disables delivery with a diagnostic without preventing the host or legacy Agent paths from starting. Configuration explicitly supplies `maxRecordBytes`, `maxContentBytes`, `maxBatchSize`, `lockTimeoutMs`, `lockRetryMs`, `scanIntervalMs`, and `watch`; `dshHome` optionally overrides the product home. Limits are positive integers and the scan interval cannot exceed one second. Mount alongside `agents`, `sessions`, and `sessionPersistence`; optional `subprocess` and message-ledger providers supply platform identity and receipt accounting.

Each record uses exclusive temporary creation, a versioned length/digest envelope, file sync, atomic publication and directory sync on POSIX. Native per-target locks serialize publication and recover watermarks with explicit skipped ranges. Linux mailbox directories and files require owner-only permissions and reject symbolic links. The product home must belong to the current user, must not be a symbolic link, and must not allow other-user writes; group writes are allowed only for the current user's primary group when system name-service enumeration finds no other supplementary or primary members, and admission is diagnosed once during provider initialization. Unavailable membership information refuses mailbox use. Existing permissions are never changed. Windows admission checks inherited DACL grants before storage initialization; foreign read/write grants are refused. Unknown process identity remains unavailable, never authorization to reclaim a Session.

<a id="model-experience"></a>
## Model Experience

### Local registration

#### What the model sees

Delivered messages retain the sender-minted identity and enter the model through `user/message`. Invalidation retains the original history and queues a separate steer notification containing the original identity and reason. Receipts never enter the inbox.

#### Token effect

Delivered text and invalidation notifications consume input tokens; registration and receipts consume none.

#### KV Cache effect

New delivered input extends request history. Invalidation appends a notification without rewriting the original model-visible prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The service arbitrates sends and controls before queue admission, retains control outcomes for replay, and restores persisted input phases before resume delivery. Hosts must preserve the Agent lifecycle ordering around Session lease acquisition and release. Priority mutation requires the priority-aware queue implementation.
- Policies are projected from durable `message/settings` events through `sessionProjections`, including host cold reads without checkpoint writes. `handoff-only` admits replies but refuses notices; admission is rechecked by the owner without clearing previously accepted inputs. Idle handoffs and replies request explicit scheduler wakeup when enabled; notices remain passive. Explicit-list previews neither write mailboxes nor wake Agents, and duplicate resolved Sessions are sent once. Receipt subscriptions resume after a publication-ordered cursor without entering the inbox. The owner tests use scheduling substitutes; real headless composition, parent/child isolation and kernel wake guarantees require integration validation.
- Windows publication, identity and permission paths require platform validation; Linux tests exercise injected Windows evidence only. Same-user hostile processes are outside the storage isolation guarantee.
