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

Configuration explicitly supplies `nodeId`, `maxRecordBytes`, `lockTimeoutMs`, `lockRetryMs`, and `scanIntervalMs`; `dshHome` optionally overrides the product home. Limits are positive integers and the heartbeat interval cannot exceed one second. Mount alongside `agents` and `sessionPersistence`; an optional `subprocess` provider supplies platform creation evidence.

Each record uses exclusive temporary creation, a versioned length/digest envelope, file sync, atomic publication and directory sync on POSIX. Native per-target locks serialize publication and recover watermarks with explicit skipped ranges. Linux directories and files require owner-only permissions and reject symbolic links. Windows admission checks inherited DACL grants before storage initialization; foreign read/write grants are refused. Unknown process identity remains unavailable, never authorization to reclaim a Session.

<a id="model-experience"></a>
## Model Experience

### Local registration

#### What the model sees

Registration and storage emit no model messages, tools, or prompt sections.

#### Token effect

Zero direct token consumption.

#### KV Cache effect

No requests or model-visible prefixes are modified.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Registration and mailbox storage do not alone activate message arbitration or delivery. Hosts must preserve the Agent lifecycle ordering around Session lease acquisition and release.
- Windows publication, identity and permission paths require platform validation; Linux tests exercise injected Windows evidence only. Same-user hostile processes are outside the storage isolation guarantee.
