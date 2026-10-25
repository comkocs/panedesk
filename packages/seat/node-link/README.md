---
description: "Explicit authenticated transport between one configured node pair."
kind: "package-reference"
---

# `@panedesk/dsh-node-link`

English | [中文](README.zh.md)

## Summary

Optional node transport establishes bidirectional loopback forwarding through a supervised OpenSSH child process, reusing existing host aliases and strict host-key verification without creating SSH keys or remote commands. Omitting `runtime` creates no listener, process, or routing service.

## Table of Contents

- [Purpose](#purpose)
- [Configuration and Identity](#configuration-and-identity)
- [Persistence and Disconnection](#persistence-and-disconnection)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="purpose"></a>
## Purpose

The fixed methods are `seat.open`, `seat.openBatch`, `seat.renew`, `seat.close`, `seat.replace`, `seat.wake`, `messages.send`, and `seat.operation`. Requests validate the version, source, target, operation ID, deadline, digest, and single-hop delegation; responses validate every correlated identity. Receivers invoke only a local executor and never forward again.

<a id="configuration-and-identity"></a>
## Configuration and Identity

`runtime` requires `nodeId`, `peerNodeId`, `peerName`, `directory`, `listenPort`, `peerPort`, `maxFrameBytes`, `requestTimeoutMs`, `maxPending`, `maxStoreBytes`, `maxOperations`, and `staleMs`. Tests use `listenPort: 0` for temporary random ports; `peerPort` points to a locally supervised forward or a test peer.

Optional `ssh` requires `alias`, `cwd`, `remotePort`, `remoteTargetPort`, `graceMs`, `keepAliveSeconds`, `keepAliveCount`, `retryMs`, and `maxRetries`, plus an existing `subprocess` service. Aliases must be simple names, not commands or arbitrary options. Both forwarding endpoints explicitly bind loopback; private SSH configuration requires operational review and must not add forwarding or change the authenticated identity.

Each node provisions `inbound.json` and `outbound.json`, containing directional node IDs, an `epoch`, and random credentials; the two directions require independent values. `provisionInbound` can create the inbound private file without printing or returning its secret. Securely provision one endpoint's inbound file as the other's outbound file; never propagate credentials through arguments, addresses, or environment variables.

The POSIX target directory must be an absolute path owned by the current user with mode `0700`; files must be regular, single-link files with mode `0600`, and paths must contain no symbolic links. Operators must prevent untrusted accounts from replacing ancestor directories. On Windows, explicitly provide `nodeLinkFiles: directory => new WindowsPrivateFiles(directory)` using the export from `@panedesk/dsh-host-admin`; defaults remain unchanged. Its [Windows storage policy](../../host/host-admin/README.md#configuration-and-identity) rejects inherited or additional SID access and reparse points, secures empty files before writing, and replaces flushed files with bounded sharing retries. A two-direction health reload starts eight metadata-only PowerShell processes without ACL caching; budget measured latency in `staleMs`. Each health probe reloads both checked directional files. `credentialOverlapMs` explicitly bounds one previous epoch's remaining lifetime; omission disables overlap. Publish the new credential with a previous entry containing its fixed `expiresAt`, then securely update the peer's outbound file. Both epochs authenticate during that interval, and the old epoch is rejected after expiry. Invalid reloads disconnect outgoing routing; coordinate publication with the probe interval.

`createDelegationIssuer` captures trusted issuer evidence and limits expiry to the original authority and request deadline. `createDelegationReceivingPolicy` verifies retained evidence and narrows it against the authenticated peer's local permission allowlist. `createNodeLinkExecutor` rechecks authorization before execution; seat writes require `localAdmission` to commit authorization and intent together, and routed messages require a host-owned exact-envelope authority. A delegation string or SSH login alone grants no authority. Without an explicit executor, configured transport composes the receiving policy, authorization transactions, local seats and `nodeAuthorizedLocalAdmission` services when all are installed. Missing services reject ingress; receivers never route again. This fallback does not install message authority.

<a id="persistence-and-disconnection"></a>
## Persistence and Disconnection

`received/operations.json` durably records pending operations before execution; `sent/operations.json` retains sending identities and results. Identical operation IDs and arguments do not execute twice; changed arguments reject. Lost responses remain unknown and recover through authenticated read-only receipts, never blind retries. Unresolved sends block new writes; full capacity rejects rather than evicts. A root `owner.lock` excludes concurrent instances; stale locks require manual confirmation before recovery.

Disconnected links reject new requests; a sent request without a response cannot be reported as unexecuted. Health probes validate process epochs and self-reported node identities. After `staleMs`, status becomes stale while retaining the last window count rather than inventing zero. A live SSH process does not imply a successful application handshake.

<a id="model-experience"></a>
## Model Experience

### Node Requests

#### What the model sees

`nodeLinkExecutor` injects no new tools or prompts; the transport carries existing method requests and results. An acceptance receipt does not mean model execution has completed.

#### Token effect

The transport makes no additional model calls; token usage depends on the original local operation.

#### KV Cache effect

Session history and cache prefixes remain unchanged.

## Known Limitations and Deferred Work

The isolated work-chain codecs recognize `node-work-chain/v1`, its seven methods, and exact `delegation-evidence` frames. Complete JSON frames include delegation, frozen input, and result wrappers; the smallest local and negotiated bound applies, with a ceiling of 1,048,576 UTF-8 bytes and no truncation or fragmentation. Diagnostic codes are limited to 128 ASCII characters and reasons to 512 UTF-8 bytes. These helpers are not connected to the default runtime: installing this package does not yet advertise or accept the capability. Configured transport provides the unique `nodeWorkChainBusiness` registry; its recovery barrier rejects absent or failed providers, and its exact query helper cannot report missing before recovery. The `chain.operation` dispatcher, hello readiness, reserved listener control capacity, and runtime composition remain unconnected; the process test establishes isolated transport-intent persistence, not end-to-end business execution or independent network evidence verification.

The independent `chain-v1.json` store retains full original intents and exact business keys. Pending, unknown, and paused results remain nonterminal; authenticated terminal repair preserves the original request identity. It never evicts unresolved records or replays ordinary methods. This store is separate from the legacy operation files and is not opened by the default runtime.

<a id="known-limitations-and-deferred-work"></a>

- Explicit `nodeLinkExecutor` providers take precedence. Otherwise the configured runtime composes receiving policy, authorization transactions, local seats, and `nodeAuthorizedLocalAdmission`; missing services refuse ingress. The local provider supports audited opening, renewal, replacement, and close, while audited rename and wake remain unavailable. Loader composition tests establish successful opening and replacement, not all six methods or production message delivery. Windows execution and real SSH acceptance have not been tested. Only one configured node pair is supported, without multi-node route registration or hot configuration rotation.

- Execution adapters must ensure their calls settle; unloading waits for accepted operations. Durable storage uses bounded whole files without compaction, automatic cleanup, or automatic stale-lock takeover. Credential files and transport records are not an engine authorization authority.

<a id="dev-note"></a>
### Dev Note

Keep transport separate from execution authority; missing local executors must reject incoming operations.
