---
description: "Graphical read-only session statistics and profile configuration."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-stats

English | [中文](README.zh.md)

## Summary

Shows session counts, subagents, token usage and recorded call timelines for the [session telemetry subsystem](../../../docs/subsystems/session-telemetry.md). The [ledger query service](../../session/ledger-query/README.md) owns aggregation and missing-measurement semantics.

The settings page's Refresh action uses the shared outlined button.

## Table of Contents

- [Configuration and use](#configuration-and-use)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="configuration-and-use"></a>
## Configuration and use

The Web bundle loads Host and Client. `enabled` defaults to true; false refuses statistics reads without stopping session recording. `refreshIntervalMs` defaults to 10000 and accepts integers from 1000 through 2147483647. Both fields are volatile profile settings, saved immediately through the existing configuration forms. Reads expose neither transcript bodies nor model operations.

A compact Statistics text button at `conversation.session.header.actions`, order 30, opens the chart modal directly, including for the minimal preset. There is no separate main-area panel, tools submenu, home-screen entry or sidebar contribution. Closing the modal releases its statistics resource; unloading removes all registrations.

Settings → Panedesk → Statistics explains the feature, enablement default, global scope and refresh interval. It shows the active profile configuration file and the local journal directory as absolute Host paths, with native opening buttons. `stats.locations()` remains readable while statistics are disabled. Unknown storage providers show no invented path. The local journal reads JSONL records below each node's `events` and `imports` directories; statistics does not modify them.

Statistics uses recorded data. Database storage can hold a readable ledger copy, while local sessions remain on this computer; it is not live session synchronization. The shared Panedesk header provides a copyable `panedesk_settings` request for the refresh interval.

Charts share one fixed-range snapshot. Existing workspace membership, session directories and parent relationships associate sessions with projects; unmatched sessions remain unlinked. Project and session selectors narrow number cards, model token bars and Beijing-aligned daily bars. Number cards wrap onto multiple rows in narrow windows so the duration remains visible. The modal stays inside the window: the description, filters and status row stay fixed while the data region scrolls, and durations display in minutes with two decimals. The relationship section starts at the current or selected session; per-call records stay collapsed behind a toggle and paginate at 30 calls per page, each bar's length matching that call's duration against the page's longest, with start and end times in the text and the hover tooltip. Missing measurements remain unknown; incomplete scans and failed refreshes are labeled. Pause retains a snapshot and refresh retries explicitly.

<a id="model-experience"></a>
## Model Experience

### Ledger observation

#### What the model sees

Statistics registers no tools, prompts or Session messages. Configuration changes affect statistics reads only.

#### Token effect

Reads and refreshes dispatch no model requests and consume no model tokens.

#### KV Cache effect

The plugin neither changes model request prefixes nor refreshes caches.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Projects require existing workspace or session metadata; internal ledger attribution is not treated as a project.
- Costs are reference estimates, not actual payments or subscription charges. Missing prices, tokens or duration remain unknown.
- Record bars compare each call's measured duration with the longest call on the same page; they do not describe full subagent lifetimes. Unfinished calls have no known duration and show no bar; sessions without calls on the current page are not listed.
- Filtering uses all call details from the selected snapshot. Large ranges can be expensive; selection is local to the open modal and there is no export workflow.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Charts use React and CSS with existing theme aliases. No charting dependency or separate statistics data service is required.

</details>
