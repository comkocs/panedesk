# `@panedesk/dsh-node-link`

English | [Chinese](README.zh.md)

Optional node transport establishes bidirectional loopback forwarding through a supervised OpenSSH child process, reusing existing host aliases and strict host-key verification without creating SSH keys or remote commands. Omitting `runtime` creates no listener, process, or routing service.

## Purpose

The fixed methods are `seat.open`, `seat.openBatch`, `seat.renew`, `seat.close`, `seat.replace`, `seat.wake`, `messages.send`, and `seat.operation`. Requests validate the version, source, target, operation ID, deadline, digest, and single-hop delegation; responses validate every correlated identity. Receivers invoke only a local executor and never forward again.

## Configuration and Identity

`runtime` requires `nodeId`, `peerNodeId`, `peerName`, `directory`, `listenPort`, `peerPort`, `maxFrameBytes`, `requestTimeoutMs`, `maxPending`, `maxStoreBytes`, `maxOperations`, and `staleMs`. Tests use `listenPort: 0` for temporary random ports; `peerPort` points to a locally supervised forward or a test peer.

Optional `ssh` requires `alias`, `cwd`, `remotePort`, `remoteTargetPort`, `graceMs`, `keepAliveSeconds`, `keepAliveCount`, `retryMs`, and `maxRetries`, plus an existing `subprocess` service. Aliases must be simple names, not commands or arbitrary options. Both forwarding endpoints explicitly bind loopback; private SSH configuration requires operational review and must not add forwarding or change the authenticated identity.

Each node provisions `inbound.json` and `outbound.json`, containing directional node IDs, an `epoch`, and random credentials; the two directions require independent values. `provisionInbound` can create the inbound private file without printing or returning its secret. Securely provision one endpoint's inbound file as the other's outbound file; never propagate credentials through arguments, addresses, or environment variables.

The POSIX target directory must be an absolute path owned by the current user with mode `0700`; files must be regular, single-link files with mode `0600`, and paths must contain no symbolic links. Operators must prevent untrusted accounts from replacing ancestor directories. Windows requires `nodeLinkFiles` with equivalent ACL checks and durable writes. Running credentials use an in-memory snapshot; rotation requires coordinated unloading, reprovisioning, and reloading at both endpoints. Hot rotation and overlap periods are not implemented.

`nodeLinkExecutor` must validate the real principal, current binding, target, and method permissions, invoke the original local provider, and provide node status. A delegation string or SSH login alone grants no authority. Missing executors reject incoming requests; routing cannot substitute for authorization.

## Persistence and Disconnection

`received/operations.json` durably records pending operations before execution; `sent/operations.json` retains sending identities and results. Identical operation IDs and arguments do not execute twice; changed arguments reject. Lost responses remain unknown and recover through authenticated read-only receipts, never blind retries. Unresolved sends block new writes; full capacity rejects rather than evicts. A root `owner.lock` excludes concurrent instances; stale locks require manual confirmation before recovery.

Disconnected links reject new requests; a sent request without a response cannot be reported as unexecuted. Health probes validate process epochs and self-reported node identities. After `staleMs`, status becomes stale while retaining the last window count rather than inventing zero. A live SSH process does not imply a successful application handshake.

## Model Experience

### Node Requests

#### What the model sees

`nodeLinkExecutor` injects no new tools or prompts; the transport carries existing method requests and results. An acceptance receipt does not mean model execution has completed.

#### Token effect

The transport makes no additional model calls; token usage depends on the original local operation.

#### KV Cache effect

Session history and cache prefixes remain unchanged.

## Known Limitations and Deferred Work

- Integrators must supply real local execution and authorization-audit adapters. Test doubles do not establish that real opening, messaging, or authorization journals are connected. Windows execution and real SSH acceptance have not been tested. Only one configured node pair is supported, without multi-node route registration or hot configuration rotation.

- Execution adapters must ensure their calls settle; unloading waits for accepted operations. Durable storage uses bounded whole files without compaction, automatic cleanup, or automatic stale-lock takeover. Credential files and transport records are not an engine authorization authority.
