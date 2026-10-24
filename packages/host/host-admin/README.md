---
description: "Explicit authenticated administration for an already running host."
kind: "package-reference"
---

# `@panedesk/dsh-host-admin`

English | [Chinese](README.zh.md)

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

Only `node.status`, `engine.pending`, `engine.approve`, `engine.operation`, and `engine.query` are available. The transport uses local loopback only and rejects browser origins, request cookies, unexpected paths or Host headers, old process epochs, and invalid authentication headers. Complete request and response frames obey the byte limit.

<a id="configuration-and-identity"></a>
## Configuration and Identity

`runtime` requires explicit `directory`, `nodeId`, `principalId`, `port`, `maxFrameBytes`, `requestTimeoutMs`, `maxPending`, `maxStoreBytes`, and `maxOperations`. Tests use `port: 0` to allocate temporary ports; deployments configure their ports. Loader assembles the configuration; the entry point does not launch through command-line arguments.

`directory` must be an exclusive absolute path with POSIX mode `0700`. Files must be regular, single-link files owned by the current user with mode `0600`. Ancestor paths must contain no symbolic links, and operators must prevent untrusted accounts from replacing ancestor directories. Windows requires `hostAdminFiles` for equivalent ACL, path, and atomic durable-write checks.

The host creates `credential` and `endpoint.json` and deletes both on exit; each start uses an independent process epoch. Credentials travel only through private files and authentication headers, never arguments, addresses, environment variables, or operation records. `callAdmin` connects only to an already running host; missing endpoints reject without automatically starting a service.

`hostAdminExecutor` receives transport-derived identity and must durably record authorization facts before accepting approval while retaining the original engine checks. Request fields cannot grant authority. Without an executor, only status and pending-approval queries against the existing engine are available; other methods explicitly reject.

<a id="persistence-and-recovery"></a>
## Persistence and Recovery

`operations.json` retains the digest, pending state, or original receipt by principal and operation ID. Pending state is durable before execution; results are durable before publication. Identical IDs and arguments return the original result; changed arguments reject. Lost responses remain unknown without automatic replay. Exhausted capacity rejects new operations rather than evicting unknown records. This transport record does not replace the engine authorization journal.

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

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- A real engine authorization executor is not included. Integrators must implement `hostAdminExecutor` and verify authorization-journal transactions, task filtering, and queries that omit body text by default. Test adapters are doubles, not evidence that these integrations are connected.
- Linux tests with doubles do not cover Windows ACL execution, real SSH, or multi-process crash injection. Executors must ensure their own calls terminate; unloading waits for accepted calls and cannot forcibly cancel arbitrary provider side effects. Nonce sets and operation records have explicit capacity limits; exhaustion requires controlled restart or operational recovery.

<a id="dev-note"></a>
### Dev Note

Keep administration behind the existing host and executor authority; do not start a second engine.
