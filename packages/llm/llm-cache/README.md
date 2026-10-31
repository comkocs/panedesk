---
description: "Session cache policy, maintenance, and model-family concurrency."
kind: "package-reference"
---

# @panedesk/dsh-llm-cache

English | [中文](README.zh.md)

## Summary

Session cache policy, maintenance, and model-family concurrency. The optional plugin provides `llmCache` for policy updates, evidence queries, and explicit renewal. Keepalive is disabled by default.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

`renewOnce` performs one explicitly requested, operation-identified keepalive at an idle maintenance point. It records ledger usage without adding a conversation body; missing evidence, an expired cache, changed prefixes, or competing maintenance can refuse renewal. Uncertain execution is not reported as successful renewal.

Call accounting belongs to the full `sessionLedger`, not this plugin. Cache policy and stable-prefix preparation run before request freezing; an instance-local call contributor supplies cache evidence and family admission to the ledger-owned call. Either plugin load order records one call. Without a ledger, requests pass through unchanged; without this plugin, the full ledger still records calls. Contributor registration is released with the plugin, and prepared contributions remain available through call settlement.

Children inherit the parent's original retention selection unless their own `cachePolicy` overrides it. Resolution uses the child route's declared capability: an unsupported inherited selection falls back to `default`, with at most one warning per child Session naming the parent selection, child route, and effective retention. Explicit child selections remain strict. Ledger cache controls and TTL describe the effective child request; `sessionPolicy` retains the selection used for subsequent inheritance and recovery.

A route entry may pin a `retention` tier that serves selections of `default` through that provider. An explicit session or request selection still wins, the pinned tier must be supported by the route capability, and a route without `retention` keeps the capability defaults byte-for-byte. `llmCache.update` stores an explicit selection without consulting the previous request's route: the tier is judged when the carrying request's provider is known, so switching models mid-session no longer reports `Unsupported cache retention` from the stale route.

Import public types from the package entry. The package is Host-only and does not provide a browser entry.

An active inbox insertion retains the existing `interjection` cache breakpoint. An `interjection` abort settles the interrupted call as `cancelled` with `upstreamStopReason: 'interjection'`, preserves partial-response artifacts, and records the breakpoint on the interrupted call and its continuation. Ordinary user cancellation remains distinct. Upstream prefix reconstruction is not suppressed: committed history replacement retains `history-edit`, and changed request headers retain `request-config-change`; each call records its actual prefix fingerprint.

<a id="model-experience"></a>
## Model Experience

### Cache maintenance

#### What the model sees

`renewOnce` can reuse an idle Session's request prefix for a maintenance call without adding its output to the conversation. The plugin contributes no user-facing tool.

#### Token effect

Admitted maintenance consumes provider input and bounded output tokens, recorded in the ledger. Evidence queries do not dispatch model calls.

#### KV Cache effect

Renewal can refresh supported provider cache evidence; expired or changed prefixes are not silently treated as reusable. Ordinary prefix reconstruction and interruption breakpoints remain active.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Renewal needs live idle-session evidence and a supported provider route. An uncertain attempted call is not replayed as a fresh renewal under the same operation identity.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
