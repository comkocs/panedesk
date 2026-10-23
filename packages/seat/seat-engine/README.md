---
description: "Durable node-local seat admission, recovery, budgets, and callback delivery."
kind: "package-reference"
---

# @panedesk/dsh-seat-engine

English | [中文](README.zh.md)

## Summary

Implements the [seat engine service](../../../docs/subsystems/seat.md) with a separate journal, durable queues, resource ownership, and callback outbox. Installation is explicit; ordinary profiles do not enable automatic opening.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount the plugin with a complete `Config` and a `sessionLedger` provider. The ledger supplies node identity; `home` selects isolated storage. Validate positive byte, batch, deduplication, callback, and recovery limits before activation. The owner-observation interval is at most one second; observation, release, and queue-wakeup budgets together must not exceed five seconds. Missing budget or node capacity limits mean unlimited, not an invented quota.

Project policy defaults to `remind` with `modeChosen: false`. Approval removes only reminder confirmation; capacity, time windows, exclusive resources, and budget checks still apply. Incomplete cost evidence blocks admission rather than counting as zero. The local executor owns Session effects; the engine retains original intent identities through recovery and never blindly retries uncertain model requests.

Committed decisions update projections and outbox delivery. Source callbacks are at-least-once with stable identities; credentials are supplied by source registrations rather than stored in engine records. Disposal stops ingress, drains owned work, flushes the journal, and releases writer ownership.

<a id="model-experience"></a>
## Model Experience

### Executor-owned work

#### What the model sees

The `seatEngine` provider contributes no tool schema or prompt. Registered executors deliver opening and budget notices through the existing message services.

#### Token effect

Admission and queries use no model tokens. Admitted work and cache maintenance can issue model requests through their respective providers; accounting includes descendants and maintenance.

#### KV Cache effect

Queries and journal commits preserve existing request prefixes. Cache maintenance is an independent provider request; unknown renewal outcomes are retained rather than replayed automatically.

## Known Limitations and Deferred Work

- Opening and recovery require a registered local executor; absent evidence leaves work pending instead of fabricating a window.
- The active provider owns a writer and reconciliation timer; it is not an offline read-only query provider.
- Account concurrency statistics are diagnostic, not an enforced account limiter.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Preserve incomplete journal tails and reject middle corruption before accepting writes. Writer ownership and committed sequence comparisons belong to the journal.

</details>
