---
description: "Explicit authenticated administration for an already running host."
kind: "package-reference"
---

# `@panedesk/dsh-host-admin`

English | [中文](README.zh.md)

## Summary

Optional administration channel for a running host. Importing the package or omitting `runtime` creates no listener, credentials, or second engine.

## Table of Contents

- [Purpose](#purpose)
- [Configuration and Identity](#configuration-and-identity)
- [Persistence and Recovery](#persistence-and-recovery)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="purpose"></a>
## Purpose

The five administrative methods are `node.status`, `engine.pending`, `engine.approve`, `engine.operation`, and `engine.query`. The additive `sdk.invoke` method dispatches only registered SDK namespaces through their decode, authorize, invoke, and encode functions; absent or unloaded namespaces return `method-unavailable`. The transport uses local loopback only and rejects browser origins, request cookies, unexpected paths or Host headers, old process epochs, and invalid authentication headers. Complete request and response frames obey the byte limit.

<a id="configuration-and-identity"></a>
## Configuration and Identity

`runtime` requires explicit `directory`, `nodeId`, `principalId`, `port`, `maxFrameBytes`, `requestTimeoutMs`, `maxPending`, `maxStoreBytes`, and `maxOperations`. Tests use `port: 0` to allocate temporary ports; deployments configure their ports. Loader assembles the configuration; the entry point does not launch through command-line arguments.

`directory` must be an exclusive absolute path with POSIX mode `0700`. Files must be regular, single-link files owned by the current user with mode `0600`. Ancestor paths must contain no symbolic links, and operators must prevent untrusted accounts from replacing ancestor directories. Windows requires `hostAdminFiles` for equivalent ACL, path, and atomic durable-write checks.

The host creates `credential` and `endpoint.json` and deletes both on exit; each start uses an independent process epoch. Credentials travel only through private files and authentication headers, never arguments, addresses, environment variables, or operation records. `callAdmin` connects only to an already running host; missing endpoints reject without automatically starting a service.

`hostAdminExecutor` receives transport-derived identity and retains the original engine checks. Without a custom executor, the runtime assembles `createHostAdminExecutor` from the running engine's issuers, transactions and queries. Listener-owned identity issues `local-operator` attribution and commits it atomically with queue approval. Self-declared dispatch authority cannot enter this path or read cached receipts; missing capabilities refuse the method. Status and pending retain their read-only engine fallback.

`hostSessionCredentials` issues separate, epoch-bound credentials into owner-only session directories. Trusted creation supplies the session and seat, plus a verified employee ID when available; request fields never supply identity. Replacing or revoking a binding removes its credential and aborts its invocation signal. Operator SDK calls have no seat; namespace authorization must reject writes without a seat. Session credentials cannot invoke the five operator methods. `callHostSdk` reads explicit endpoint and credential paths, sends one request, and never retries unknown outcomes.

<a id="persistence-and-recovery"></a>
## Persistence and Recovery

`operations.json` retains the digest, pending state, or original receipt by principal and operation ID. Pending state is durable before execution; results are durable before publication. Identical IDs and arguments return the original result; changed arguments reject. Lost responses remain unknown without automatic replay. Exhausted capacity rejects new operations rather than evicting unknown records. This transport record does not replace the engine authorization journal.

`engine.operation({ operationId })` reads the engine journal rather than the transport receipt: `approval` records queue registration, while `progress` distinguishes pending reasons and blockers, correlated opening phases, and cancellation. Created windows and first-turn failures remain distinct after restart. Queries do not drive or replay work.

`engine.query({ limit, taskId?, seat?, kind?, cursor?, authorizationCursor? })` returns redacted `effects` and an independent `authorizations` page from the issued-fact projection, including `plugin` and `local-operator` kinds. Each page has its own `complete`, `watermark` and `nextCursor`; continue effects with `cursor` and facts with `authorizationCursor`. The bound applies to each page and the complete response byte limit still applies. Frozen instructions and raw source data are omitted; queries offer no raw-body opt-in.

`owner.lock` permits only one running instance per directory. A lock left after abnormal exit requires explicit recovery after operators confirm the old instance has exited; the plugin never guesses ownership from a PID.

<a id="model-experience"></a>
## Model Experience

### Administration Requests

#### What the model sees

`hostAdminExecutor` injects no tools, prompts, or session content; callers receive administration results. An approval receipt does not mean a window has finished opening.

#### Token effect

The channel itself makes no model requests and consumes no model tokens.

#### KV Cache effect

Existing session history and cache prefixes remain unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `engine.operation` requires the engine's optional operation projection; older providers without it remain unavailable. An admitted intent with no committed creation or failure remains pending, not successful. Legacy custom executors may omit the authorization page; callers must not interpret an absent page as empty authorization history.
- Linux tests with doubles do not cover Windows ACL execution, real SSH, or multi-process crash injection. Executors must ensure their own calls terminate; unloading waits for accepted calls and cannot forcibly cancel arbitrary provider side effects. Nonce sets and operation records have explicit capacity limits; exhaustion requires controlled restart or operational recovery.

Revocation deletes credential files but leaves their empty owner-only session directories. Long-running deployments must remove empty directories during stopped-host maintenance; directory reclamation is not part of the private-file policy yet.

<a id="dev-note"></a>
### Dev Note

Keep administration behind the existing host and executor authority; do not start a second engine.
