---
description: "Owner-authorized node health and parked callback settings."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-nodes

English | [中文](README.zh.md)

## Summary

Adds a secondary Nodes section to Settings in the [Web client](../../../docs/subsystems/web-client.md). The [host administration provider](../../host/host-admin/README.md) owns node observations and existing operator execution; this plugin exposes only authenticated-owner reads and confirmed local actions.

## Table of Contents

- [Configuration and use](#configuration-and-use)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="configuration-and-use"></a>
## Configuration and use

The Web bundle loads Host and Client together with `enabled: false`. The page explains multi-machine use and has a global, current-profile switch backed by the configured node-link entry's `enabled` field, also false by default. Disabling it drains the transport through the normal Loader lifecycle and stops browser polling; manual reads and configuration remain available. Configure exactly one node-link `runtime` before enabling; the page never installs an engine or provisions credentials. `refreshIntervalMs` defaults to 10000, accepts integers from 1000 through 2147483647, and saves through the profile editor when the field loses focus. It controls observation refresh, not transport heartbeats or callback retries. `pageSize` defaults to 200 and accepts integers from 1 through 200. Missing providers remain unavailable. Unloading cancels polling and admission, then waits for accepted actions to settle.

The page displays the Host's absolute profile patch path and directory, with the existing desktop open/reveal actions. The standard location is `$PANEDESK_HOME/profiles/<profile>/cordis.patch.yml`; node-link peer settings and seat-engine callback settings share this file. Settings apply across workspaces in that Host profile, not to a selected project. Credential files and callback journals remain in their separately configured private storage and are not read by this page.

The section uses the shared node glyph and contributes no initial-screen, sidebar or main-area entry. Node rows show local identity, engine and link observations, unknown capacity, the last successful authenticated round trip and expandable process-local events from this startup. Rebuild replaces only this host's tunnel to the selected peer; operate on another node to rebuild its outbound links. A new child is not evidence of a recovered authenticated link.

Parked callback rows use live outbox observations and retain the expected attempt. Source-owner rows retain their original operator key. Resume and abandon require a confirmation naming the action and target; all writes reuse existing local-operator authorization. Provider refusal and unknown outcomes remain distinct from acceptance. Unknown results must be inspected before retrying; this plugin never automatically repeats writes. Default, loading, empty, read-error, unauthorized, disabled, success and action-failure states have English and Chinese copy.

<a id="model-experience"></a>
## Model Experience

### Node administration

#### What the model sees

The `settings.section` contribution registers no tools, prompts or Session messages. Observations and confirmations are user-visible only.

#### Token effect

Reads and tunnel rebuilds dispatch no model requests. Resuming existing work retains that work's ordinary execution and token policy; the page makes no model call itself.

#### KV Cache effect

The plugin changes no model request prefixes or caches.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Events are not persisted and retain only the latest 20 entries per peer since startup. Heartbeats are observation times, not engine readiness timestamps.
- Callback lists are bounded and label incompleteness. Source-owner pages have no completeness proof; an empty result does not establish that all work is clear.
- Missing historical attempt timestamps remain unknown. Recovered retry lower bounds display “At least N”; source adapters do not invent timestamps from creation or recovery times. Parked callback rows show failed attempts and direct pending dispatches as separate counts with their own first and last times. A summary written before that split shows “Not recorded” for both groups and never derives them from the combined count.
- The page cannot rebuild a remote node's own outbound links, repair credentials or reverse an abandonment. An accepted operation still requires a fresh read to inspect its outcome.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
