---
description: "Service definitions for node-local seats, engine operations, policies, and registered directories."
kind: "package-reference"
---

# @panedesk/dsh-seat

English | [中文](README.zh.md)

## Summary

Defines the seat services and shared request, result, event, and policy types. Importing this package does not install an engine, create Sessions, or register tools. The [seat subsystem](../../../docs/subsystems/seat.md) owns the type reference.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Optional opening snapshots and trigger references preserve provider revision and task evidence without changing legacy opening requests. `SeatGateService.evaluateTaskScopes` is an optional preflight capability; task-aware callers must refuse rather than bypass an absent evaluator. Authorization declarations expose host-owned issuer registrations, process-local grants, atomic action transactions, and historical queries. Importing these definitions installs none of their providers; `seat-engine` supplies persistence and queries.

Providers implement `SeatService`, `SeatEngineService`, `SeatGateService`, and `SeatDirectoryService`. Consumers resolve optional services with `ctx.get`; missing providers do not authorize operations or activate replacements. `withAuthority` accepts authenticated server-side authority, never identity claims copied from a request.

Stable operation identities, revision comparisons, explicit incomplete pages, and typed refusals preserve observable outcomes across retries. Engine decisions live outside the Session event union. Configuration and execution belong to providers; the declarations supply no deployment defaults.

<a id="model-experience"></a>
## Model Experience

### Service declarations

#### What the model sees

`SeatService` and the other declarations contribute no tools, prompt text, or messages.

#### Token effect

Importing the definitions adds no request tokens and starts no model requests.

#### KV Cache effect

The package does not change request prefixes or refresh provider caches.

## Known Limitations and Deferred Work

- Services require separately installed providers; declarations alone cannot open, renew, close, or query a window.
- Live operations are node-local. A node identifier is not permission to execute on another node.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Providers own durable commits and awaited disposal; consumers must not infer success from missing evidence.

</details>
