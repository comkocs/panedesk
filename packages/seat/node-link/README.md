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

Optional `messages.sendSeat` carries one exact `{ nodeId, seat }` and the frozen delivery envelope; `messages.onlineSeats` carries only an operation identity. Both require the peer's `seat-messages/v1` advertisement and explicit per-method delegated permission. The authenticated node pair, original sender session and exact payload digest are checked before local execution. Unknown seat sends query their original receipt; only authenticated `missing` permits the original payload to be sent again. Online queries bypass intent storage and never reserve a window. Missing receiver or authority refuses rather than widening permissions. Upgrade both nodes before enabling these methods; old closed-set readers cannot read new-method records, so preserve unresolved stores with a compatible reader before rollback.

<a id="configuration-and-identity"></a>
## Configuration and Identity

`runtime` requires `nodeId`, `peerNodeId`, `peerName`, `directory`, `listenPort`, `peerPort`, `maxFrameBytes`, `requestTimeoutMs`, `maxPending`, `maxStoreBytes`, `maxOperations`, and `staleMs`. Tests use `listenPort: 0` for temporary random ports; `peerPort` points to a locally supervised forward or a test peer.

Optional `runtime.forwardedHosts` is an exact list of forwarding entrance `host:port` authorities. Hosts must be `127.0.0.1`, `localhost`, or `[::1]`, with an explicit canonical decimal port from 1 to 65535; wildcards, ranges, missing ports, and other hosts fail configuration validation. Set each receiving node's list to the exact Host used by its paired sender at the forwarding entrance. Host aliases are not interchangeable. Omission or an empty list accepts only the original listener authority. Authentication, browser-header rejection, and admin endpoints remain unchanged.

A node-link Host refusal logs one `host-mismatch` line with `expectedPort` (the receiving listener) and `actualPort` (the Host port, or `null` in JSON and `unknown` in logs if invalid). If all other admission checks pass and the frame limit permits, the HTTP 403 hello response includes those three fields. The sender projects only the allowlisted `host-mismatch` code into `safeReason`; it does not expose addresses or credentials or treat a refusal as authenticated peer health. Other refusal responses retain the generic transport failure.

Optional `ssh` requires `alias`, `cwd`, `remotePort`, `remoteTargetPort`, `graceMs`, `keepAliveSeconds`, `keepAliveCount`, `retryMs`, and `maxRetries`, plus an existing `subprocess` service. Optional `sshConfigFile` supplies one `-F` argv value; omission preserves OpenSSH's existing configuration selection. Paths must be nonempty, at most 4096 characters, contain no control characters and not start with `-`. Aliases must be simple names, not commands or arbitrary options. Both forwarding endpoints explicitly bind loopback; private SSH configuration requires operational review and must not add forwarding or change the authenticated identity.

Each node provisions `inbound.json` and `outbound.json`, containing directional node IDs, an `epoch`, and random credentials; the two directions require independent values. `provisionInbound` can create the inbound private file without printing or returning its secret. Securely provision one endpoint's inbound file as the other's outbound file; never propagate credentials through arguments, addresses, or environment variables.

The POSIX target directory must be an absolute path owned by the current user with mode `0700`; files must be regular, single-link files with mode `0600`, and paths must contain no symbolic links. Operators must prevent untrusted accounts from replacing ancestor directories. On Windows, explicitly provide `nodeLinkFiles: directory => new WindowsPrivateFiles(directory)` using the export from `@panedesk/dsh-host-admin`; POSIX defaults remain unchanged. Windows startup waits up to `requestTimeoutMs` for an active factory, never falls back to POSIX, and reports missing factories or file failures through Cordis startup errors. Composition changes during startup cancel the old attachment without publishing services from its inactive context; initial startup waits for the replacement attachment and propagates its failures. Its [Windows storage policy](../../host/host-admin/README.md#configuration-and-identity) rejects inherited or additional SID access and reparse points, secures empty files before writing, and replaces flushed files with bounded sharing retries. Health reloads use fresh in-process Win32 metadata checks without PowerShell processes or ACL caching; budget measured latency in `staleMs`. Each health probe reloads both checked directional files. `credentialOverlapMs` explicitly bounds one previous epoch's remaining lifetime; omission disables overlap. Publish the new credential with a previous entry containing its fixed `expiresAt`, then securely update the peer's outbound file. Both epochs authenticate during that interval, and the old epoch is rejected after expiry. Invalid reloads disconnect outgoing routing; coordinate publication with the probe interval.

`createDelegationIssuer` captures trusted issuer evidence and limits expiry to the original authority and request deadline. `createDelegationReceivingPolicy` verifies retained evidence and narrows it against the authenticated peer's local permission allowlist. `createNodeLinkExecutor` rechecks authorization before execution; seat writes require `localAdmission` to commit authorization and intent together, and routed messages require a host-owned exact-envelope authority. A delegation string or SSH login alone grants no authority. Without an explicit executor, configured transport composes the receiving policy, authorization transactions, local seats and `nodeAuthorizedLocalAdmission` services when all are installed. Missing services reject ingress; receivers never route again. The fallback reads optional `routedMessageReceiver` and `nodeMessageAuthority` services through `ctx.get`; missing message capabilities preserve the existing refusal.

The transport does not publish `nodeMessageEvidence` or `nodeMessageEvidenceRemote`. Routed messages use the host-owned exact-envelope authority above; there is no separate evidence query or `message-delegation-evidence` control frame.

The seat engine's `callbackTimeoutMs` covers the remaining callback work. It no longer waits for message-evidence publication.

<a id="persistence-and-disconnection"></a>
## Persistence and Disconnection

`received/operations.json` durably records pending operations before execution; `sent/operations.json` retains sending identities and results. Identical operation IDs and arguments do not execute twice; changed arguments reject. Lost responses remain unknown and recover through authenticated read-only receipts, never blind retries. Unresolved sends block new writes; full capacity rejects rather than evicts. A root `owner.lock` excludes concurrent instances; stale locks require manual confirmation before recovery. Normal disposal and `SIGINT`/`SIGTERM` share idempotent teardown: probe, chain, tunnel, listener and stores are drained and lock release is attempted even after earlier cleanup failures. Signal listeners are removed during teardown; forced termination cannot clean up, and process exit remains the supervisor's responsibility.

Before network dispatch, work-chain requests recheck both request and delegation deadlines after evidence and intent publication. Expiry returns `deadline-exceeded` without network activity or withdrawing the connection; any admitted intent durably retains `effectState: 'none'`. Only callback delivery can recover this transport receipt. Pre-dispatch deadline expiry and missing peer capability are explicitly retryable only for callback delivery and exact queries of its original key; identity, authorization and initiating-method refusals retain their existing classification. Initiating methods rejected before sending remain final and are not automatically sent when the link recovers.

Disconnected links reject new requests before capability negotiation. Work-chain transport failures before TCP connection return `node-tunnel-disconnected` with `effectState: 'none'`, durably settle any admitted sending intent, and withdraw the observed connection and peer capability. An authorized exact `chain.operation` query can read that local refusal even while disconnected; it is not inferred business evidence. Once TCP connects, missing responses remain unknown with pending sending records; authenticated exact queries reconcile recovered business results without repeating execution. A sent request without a response cannot be reported as unexecuted. Health probes validate process epochs and self-reported node identities. After `staleMs`, status becomes stale while retaining the last window count rather than inventing zero. A live SSH process does not imply a successful application handshake.

Tunnel starts, exits, retries, exhaustion, and supervision failures use the host logger; stderr retains only an address-redacted tail summary of at most five lines, 200 bytes per line, and 1 KB in total. Raw stderr retention is bounded to 4 KB; stdout is discarded. A child surviving at least `retryMs` resets the retry budget before the next retry; shorter-lived children consume the bounded `maxRetries` budget, and every retry waits `retryMs`. After exhaustion, `nodeRouter.status()` and node queries expose the last exit reason through `safeReason`. The authenticated admin `node.rebuild` method replaces only the owned tunnel and restores its bounded supervision, stderr capture and retry budget; concurrent rebuilds share one replacement. Old retries are cancelled before replacement, and disposal cannot restart a child. The host and directional credentials remain unchanged. Routing remains disconnected until the regular authenticated hello succeeds; child creation alone is not link recovery.

`NodeLinkStatus.lastHeartbeatAt` is the last successful authenticated round-trip observation, initially unknown and unchanged by failed probes. Optional `events` retains the latest 20 credential-free link and authentication events per peer in this process only; it resets at startup. Optional `exhausted` distinguishes exhausted supervision from reconnecting. `node.rebuild({ peerNodeId })` accepts only the configured peer and replaces this node's outbound tunnel; omission preserves the original action. It never rebuilds a peer's own outbound links.

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

Explicit `nodeWorkChain` composition enables `node-work-chain/v1`, seven fixed methods, and exact `delegation-evidence` frames. Hello advertises receiving capability only after business providers, local admission, receiving policy and durable evidence recover. Provider withdrawal removes the capability. Late installation or replacement of `nodeWorkChain` drains the previous transport before remounting; unloading does not wait for an injected evidence provider whose readiness never completes. Complete JSON frames include delegation, frozen input and result wrappers; the smallest local and negotiated bound applies, with a ceiling of 1,048,576 UTF-8 bytes and no truncation or fragmentation. Diagnostic codes are limited to 128 ASCII characters and reasons to 512 UTF-8 bytes. Control requests have separate bounded capacity. Authenticated `chain.operation` calls query the recovered business owner, never infer missing from transport receipts.

Optional `seat.definitionRevision` requires both peers to advertise the independent hello field `seatDefinitionRevision: 'seat-definition-revision/v1'`; `chain.methods` remains the legacy seven-method set. Missing either capability refuses before sending. Explicit `local.methods` and `local.definitionRevisions` must supply a ready, available provider; withdrawal removes this capability immediately. Receiving policy must authorize the exact read and seat and validate trusted source ownership and epoch before issuing a separate exact grant. Reads use ordinary business capacity but bypass intent stores, business queries and outbox replay; only bounded authorization evidence is retained. Read before first preparation; recover persisted preparation and its original revision/digest instead of rereading under the same key. Observation and admission are not atomic, so a changed version safely refuses rather than transparently refreshing. Upgrade both nodes together. Once new-method authorization evidence has been written, the old closed-set decoder cannot read those records. Before rollback, disable reads and preserve the records with a compatible reader or isolated storage; never delete records to make an old program start.

`route(request, authorization)` requires a fresh entry grant matching every delegation field. Before transmission, node-link durably retains its fact in bounded `chain-evidence/evidence-v1.json`; only the authenticated paired node can query an exact entry, and expired evidence is removed during recovery or publication. Independent `chain-received/chain-v1.json` and `chain-sent/chain-v1.json` retain complete original intents and exact business keys without evicting unresolved records. Pending and unknown results remain nonterminal; owner pauses and refusals are not reopened. An optional host-owned `outboxIssuer` permits original-method retransmission only after an authenticated business query reports missing, using the persisted payload and original key with fresh restricted authority. Without this issuer, unresolved sends remain unknown; no `resume` method is invoked. Without chain composition, these files are not opened.

Startup after readiness, online hello and reconnection scan response-less unresolved intents for every admitted method. Sender-generated `node-deadline-exceeded` or `node-tunnel-disconnected` receipts with no effect are recoverable only for `source.deliverCallback`, including old records without metadata. Initiating methods (`engine.acceptFrozen`, `seat.openFrozen`, `seat.wakeFrozen`, and `source.prepareOpening`) rejected on a disconnected link or before dispatch remain final; recovery never automatically sends them, and exact queries retain their admitted local refusal even when online. In-flight interruptions without a response still use original-key verification. Recovery obtains fresh restricted authority and queries the exact recovered owner. Only authenticated durable `missing` permits one original-method send with a fresh wire request ID; the business key, payload digest and frozen route never change. Unknown, timeout, disconnect, unavailable capability or denied authority cannot permit a replay. Committed owner evidence repairs the receipt without sending. Same-key sends and recovery serialize; repeated expiry waits for another recovery trigger rather than looping. Owner refusals do not become transport replay candidates, and the seat outbox uncertainty barrier remains unchanged.

Optional internal `chain-sent` fields `transportNone` and `recovery` distinguish sender refusals from owner responses and retain `attemptId` plus `history` entries containing each prior `response` and `reactivatedAt`. Reactivation compares the original key, digest and observed receipt before publication; stale attempts cannot settle a reactivated entry. History counts against the existing storage byte limit and is never discarded to make room. New readers accept old records directly. Old readers reject records containing these optional fields: before rollback, preserve them with a compatible reader or isolated storage; never delete receipts or history to make an old program start.

<a id="known-limitations-and-deferred-work"></a>

- Explicit `nodeLinkExecutor` providers take precedence. Otherwise the configured runtime composes receiving policy, authorization transactions, local seats, and `nodeAuthorizedLocalAdmission`; missing services refuse ingress. The local provider supports audited opening, renewal, replacement, and close, while audited rename and wake remain unavailable. Loader composition tests establish successful opening and replacement, not all six methods or production message delivery. Windows execution and real SSH acceptance have not been tested. Only one configured node pair is supported, without multi-node route registration or hot configuration rotation.

- Execution adapters must ensure their calls settle; unloading waits for accepted operations. Durable storage uses bounded whole files without compaction, automatic cleanup, or automatic stale-lock takeover. Credential files and transport records are not an engine authorization authority.

<a id="dev-note"></a>
### Dev Note

Keep transport separate from execution authority; missing local executors must reject incoming operations.
