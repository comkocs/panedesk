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

The administrative methods are `node.status`, `engine.pending`, `engine.approve`, `engine.operation`, `engine.query`, `engine.cancel`, `engine.callbackResolve`, `source.operations`, `source.abandon`, and `source.resend`. The additive `sdk.invoke` method dispatches only registered SDK namespaces through their decode, authorize, invoke, and encode functions; absent or unloaded namespaces return `method-unavailable`. The transport uses local loopback only and rejects browser origins, request cookies, unexpected paths or Host headers, old process epochs, and invalid authentication headers. Complete request and response frames obey the byte limit.

<a id="configuration-and-identity"></a>
## Configuration and Identity

`runtime` requires explicit `directory`, `nodeId`, `principalId`, `port`, `maxFrameBytes`, `requestTimeoutMs`, `maxPending`, `maxStoreBytes`, and `maxOperations`. Tests use `port: 0` to allocate temporary ports; deployments configure their ports. Loader assembles the configuration; the entry point does not launch through command-line arguments.

Admin endpoints accept only the actual listener's IPv4 loopback Host authority and retain empty HTTP 403 refusals. The shared `listenAuthenticatedLoopback` helper optionally accepts an exact loopback forwarding-authority list and a safe Host-refusal reporter for [node-link](../../seat/node-link/README.md#configuration-and-identity); admin supplies neither. Authentication, fixed path, and browser-header checks remain mandatory. `callLoopback` decodes bounded Host refusals only when explicitly requested; other callers retain generic transport errors.

`directory` must be an exclusive absolute path with POSIX mode `0700`. Files must be regular, single-link files owned by the current user with mode `0600`. Ancestor paths must contain no symbolic links, and operators must prevent untrusted accounts from replacing ancestor directories. On Windows, explicitly provide `hostAdminFiles: directory => new WindowsPrivateFiles(directory)` from this package (and the same factory as `callHostSdk`'s `privateFiles` option); POSIX defaults are unchanged. Windows startup waits up to `requestTimeoutMs` for an active factory, never falls back to POSIX, and reports missing factories or file failures through Cordis startup errors. Consumer disposal cancels waiting without reporting factory absence; an inactive startup releases its resources without publishing further services. The provider accepts drive-qualified local paths, rejects reparse points throughout the path, and requires a protected DACL with exactly one current-user SID FullControl allow rule and the same owner SID; existing ACLs are rejected, never repaired. New empty objects receive this ACL before content is written and flushed; same-directory replacement uses write-through `MoveFileExW`, with at most five attempts and 10/20/40/40 ms backoff for access/sharing contention. Security operations use the in-process Node-API Win32 binding, require no elevation, and never spawn PowerShell or fall back to it. No identity, ACL or path result is cached: each existing-file read combines fresh file and private-directory ACLs, owner SIDs, and a complete ancestor reparse-point traversal. The read-only handle is opened before inspection; its identity is compared with the pre-open and post-inspection pathname metadata before any bytes are read. Missing files still require directory verification. Operators must prevent concurrent untrusted ancestor replacement; pathname metadata is not a handle-bound Windows security check. Measure deployment latency before choosing non-overlapping probe intervals; process startup time is not a network health deadline.

The host creates `credential` and `endpoint.json` and deletes both on exit; each start uses an independent process epoch. Credentials travel only through private files and authentication headers, never arguments, addresses, environment variables, or operation records. `callAdmin` connects only to an already running host; missing endpoints reject without automatically starting a service.

`hostAdminExecutor` receives transport-derived identity and retains the original engine checks. Without a custom executor, the runtime assembles `createHostAdminExecutor` from the running engine's issuers, transactions and queries. Listener-owned identity issues `local-operator` attribution and commits it atomically with queue approval. Self-declared dispatch authority cannot enter this path or read cached receipts; missing capabilities refuse the method. Status and pending retain their read-only engine fallback.

`hostSessionCredentials` issues separate, epoch-bound credentials into owner-only session directories. Trusted creation supplies the session and seat, plus a verified employee ID when available; request fields never supply identity. Replacing or revoking a binding removes its credential and aborts its invocation signal. Operator SDK calls have no seat; namespace authorization must reject writes without a seat. Session credentials cannot invoke the administrative methods. `callHostSdk` reads explicit endpoint and credential paths, sends one request, and never retries unknown outcomes.

`source.operations({ limit? })` reads the optional `hostAdminSourceOperator.list` provider without changing its items; `limit` is an integer from 1 through 200. `source.abandon` and `source.resend` accept `{ operationId, key, reason }` and require local-operator authority plus an allowed issuer grant matching the node, principal, operation and request digest. The provider receives the original grant and owns audit, release and resend semantics. `key` is 1–512 characters and `reason` is 1–500; unknown fields reject. Results contain at most 200 items in `awaiting-manual` or `parked-none` state, bounded strings and ISO timestamps; write results are `ok` or `rejected` with an optional positive generation. Missing providers or optional `resend` return `unavailable` with `admin-method-unavailable`. The service is not an injection dependency. `callAdmin` and its SDK export `callHostAdmin` use only the operator channel; `sdk.invoke` and session credentials gain no source methods.

<a id="persistence-and-recovery"></a>
## Persistence and Recovery

`operations.json` retains the digest, pending state, or original receipt by principal and operation ID. Pending state is durable before execution; results are durable before publication. Identical IDs and arguments return the original result; changed arguments reject. Lost responses remain unknown without automatic replay. Exhausted capacity rejects new operations rather than evicting unknown records. This transport record does not replace the engine authorization journal.

`engine.cancel({ operationId, queueItemId, expectedStateVersion, reason? })` requires a local operator grant bound to the configured node, principal, operation and request digest. It calls the running engine's authorized cancellation capability; node delegation and session credentials cannot cancel. The optional reason is limited to 512 UTF-8 bytes without control characters. Cancellation and issued operator attribution commit together in the engine journal. `engine.operation` returns the settled cancellation receipt, including who, when, which queue item, reason and outcome; redacted queries expose only reason presence. Unknown, dispatched and opened targets retain `revision-conflict` with a structured `cause.reasonCode`; stale versions retain the original refusal. Transport receipts still replay after restart and preserve unknown outcomes after lost responses; cancellation adds no remote entry.

`engine.operation({ operationId })` reads the engine journal rather than the transport receipt: `approval` records queue registration, while `progress` distinguishes pending reasons and blockers, correlated opening phases, and cancellation. Created windows and first-turn failures remain distinct after restart. Queries do not drive or replay work.

`engine.query({ limit, taskId?, seat?, kind?, cursor?, authorizationCursor? })` returns redacted `effects` and an independent `authorizations` page from the issued-fact projection, including `plugin` and `local-operator` kinds. Each page has its own `complete`, `watermark` and `nextCursor`; continue effects with `cursor` and facts with `authorizationCursor`. The bound applies to each page and the complete response byte limit still applies. Frozen instructions and raw source data are omitted; queries offer no raw-body opt-in.

Normal disposal and `SIGINT`/`SIGTERM` drain owned resources and attempt credential, endpoint and lock removal even when an earlier cleanup rejects. Termination listeners are removed by the same idempotent disposal; forced termination cannot run cleanup. The deployment's process supervisor retains ownership of process exit.

`reportHostFailure` appends one fixed-summary error line to `~/.panedesk/logs/host-errors.log` and stderr. Only explicitly allowlisted machine codes are retained; exception messages, stacks, paths and URLs are never formatted. Log append failures produce a separate fixed stderr line. This helper does not install the boot fatal handler.

Windows acceptance: after building the native addon on Windows, run `pnpm exec tsx packages/host/host-admin/tests/windows-private-files-native.mts` from the repository root. It checks real private-file operations, hard-link and junction refusal, lock exclusion/release and twenty replacement writes; output reports median/P95 milliseconds with targets 3000/5000 ms. Linux oracle tests do not establish Windows execution or latency.

`owner.lock` permits only one running instance per directory. A lock left after abnormal exit requires explicit recovery after operators confirm the old instance has exited; the plugin never guesses ownership from a PID.

<a id="callback-resolution"></a>
### Callback resolution

`engine.callbackResolve({ callbackId, action: 'resume' | 'abandon', expectedAttempt })` uses only authenticated `local-operator` authority, with the same node, principal and exact-request grant checks as cancellation. The running engine commits one `callback/attempted` transition and operator authorization together. Resume keeps the attempt and original payload, enters `retry-due`, and starts a new retention segment; abandon enters terminal `abandoned`. The same callback ID, action and expected attempt replay current state without a frame, including after restart, only if no newer parking frame follows that action. Otherwise non-paused state refuses before attempt comparison; new parking at the same attempt permits a new resolution. Unknown callbacks, non-paused state and attempt mismatch return `callback-unknown`, `callback-not-paused` and `callback-attempt-conflict`; invalid authority returns `admin-unauthorized` or `callback-resolution-unauthorized`. Transport uncertainty returns `uncertain / admin-outcome-unknown`, never automatic retry.

Read `engine.query` for fixed local diagnostic codes `callback-unclassified-error`, `callback-timeout`, `callback-authentication-failed` and `callback-protocol-error`, without raw exception text. The engine's built-in 900000 ms window starts at the first committed attempted frame of the current transient segment; restarts and changed transient detail codes do not reset it. Parking produces no further callback frames until resolution. `callback-link-unreachable-limit` resumes once per parking on a newer ready hello with `callback-auto-resumed-on-link-ready`; `callback-transient-limit-reached` requires an operator. Ordered `(sourceId, sessionId, triggerId)` groups keep ended behind paused opened; resume waits for delivered, while abandon releases the next drive. Full timing and unknown-barrier rules belong to the [engine](../../seat/seat-engine/README.md#callback-parking-and-operator-resolution).

In an operator command-line session, use the already configured checked `files` provider and `limits`; this call neither starts another host nor accepts a credential in its arguments:

```js
const { callHostAdmin } = await import('@panedesk/dsh-host-admin');
const result = await callHostAdmin(files, 'engine.callbackResolve', {
  callbackId, action: 'abandon', expectedAttempt,
}, limits);
console.log(result);
```

Use `action: 'resume'` to retry the same callback after correcting its prerequisites. Obtain `callbackId` and the current `attempt` from the complete query result before choosing the action.

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

- M8b: callback abandon does not alter `chain-sent` or create an owner terminal receipt; retained transport recovery remains independent.
- Cancellation requires the engine's optional authorized cancellation capability; missing capability refuses rather than invoking the unaudited path. External scope-reservation release remains owned by its provider and is not implemented by the administration transport.
- `engine.operation` requires the engine's optional operation projection; older providers without it remain unavailable. An admitted intent with no committed creation or failure remains pending, not successful. Legacy custom executors may omit the authorization page; callers must not interpret an absent page as empty authorization history.
- Linux tests with doubles do not cover Windows ACL execution, real SSH, or multi-process crash injection. Executors must ensure their own calls terminate; unloading waits for accepted calls and cannot forcibly cancel arbitrary provider side effects. Nonce sets and operation records have explicit capacity limits; exhaustion requires controlled restart or operational recovery.

Revocation deletes credential files but leaves their empty owner-only session directories. Long-running deployments must remove empty directories during stopped-host maintenance; directory reclamation is not part of the private-file policy yet.

<a id="dev-note"></a>
### Dev Note

Keep administration behind the existing host and executor authority; do not start a second engine.
