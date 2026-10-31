---
description: "Owner-authorized read-only statistics from the public session ledger."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-stats

English | [中文](README.zh.md)

## Summary

Provides five read-only statistics tabs for the [session telemetry subsystem](../../../docs/subsystems/session-telemetry.md): project overview, historical statistics, model usage, model throughput and ledger details. The [ledger query service](../../session/ledger-query/README.md) owns aggregation and unknown-evidence semantics.

## Configuration and use

The Web bundle loads both Host and Client. `enabled` defaults to true; setting it false refuses reads. `refreshIntervalMs` defaults to 10000 and accepts integers from 1000 through 2147483647. Only authenticated owner invocations can call `stats.read(request)`; callers cannot supply an identity. Missing services, cancellation and disabled access fail explicitly. No write, export, transcript or model operation is exposed.

Settings contains a secondary Statistics summary and an “Open in main area” action. A session-only tools menu opens the same `main` panel. There is no initial-screen or sidebar panel-list contribution. Closing or unloading the plugin removes its entries and cancels resource polling.

All tabs share time range, grouping and Beijing hour/day buckets. Seat selection narrows a project; model selection narrows all five tabs and remains visible and clearable after changing tabs. Pause reads one snapshot, resume restores polling, and refresh requests a new read. Layout and reduced-motion controls affect presentation only. Missing or incomplete evidence remains visible rather than becoming zero. Default, loading, empty, error, unauthorized, disabled, success and failed-refresh states have English and Chinese copy; failed refresh never claims an update succeeded.

## Model Experience

### Ledger observation

#### What the model sees

The plugin registers no tools, prompts or Session messages. Statistics remain user-visible observations.

#### Token effect

Reads and refreshes dispatch no model requests and consume no model tokens.

#### KV Cache effect

The plugin neither changes model request prefixes nor refreshes caches.

## Known Limitations and Deferred Work

- Projects use ledger seats, not workspace directories; running sessions are ledger lifecycle evidence, not process-liveness observations.
- Reference prices are not actual payments or subscription charges. Missing prices, usage, duration or remote-alias evidence remain unknown.
- Reads cover the available public ledger snapshot. Incomplete scans are labeled; the plugin cannot repair missing producer evidence.
- Selection and layout are local to the mounted panel. The UI has no mutation or export workflow.
