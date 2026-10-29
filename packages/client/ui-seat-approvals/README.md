---
description: "Opt-in owner confirmation of pending seat openings and durable opening feedback."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-seat-approvals

English | [中文](README.zh.md)

## Summary

Provides an opt-in approval surface for the [seat subsystem](../../../docs/subsystems/seat.md). The existing engine owns admission, authorization transactions and opening evidence; the UI does not start another engine or request a new opening alongside queued work.

## Table of Contents

- [Configuration and use](#configuration-and-use)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Configuration and use

The Web bundle includes an inert row named `ui-seat-approvals`. A later profile patch enables it with `config: { enabled: true }`; the Host and Client must include the same package. `enabled` defaults to false, `pollIntervalMs` to 1000 and `pageSize` to 100. The positive observation interval bounds queue and operation refresh; the positive page size bounds each engine read.

Only authenticated owner Remote invocations can read enabled pending work, approve, cancel or observe operations. The adapter captures the running node and pending seat/task attribution, obtains an instance-owned local-operator grant, and calls the existing transactional approval or cancellation capability. It never reads private endpoint credentials or accepts authority from request fields. Missing capabilities refuse rather than fall back to unaudited mutation.

An additive `shell.overlay` entry places the pending-count control at the top-right without replacing occupied single header slots. Zero pending approvals hides the count. The dialog shows seat, related tasks, frozen window name, authenticated frozen-chain target and retained budget limits. Missing fields remain unavailable; budget values are displayed as integer micro-USD, including zero. Incomplete or failed observations disable mutations.

Approve and cancel carry the observed queue version and a fresh operation identity. A conflict requires reviewing the refreshed entry. Submitted queue revisions cannot be submitted again in the mounted surface; an unknown transport outcome retains its operation identity for observation rather than replay. Approval is only confirmation: capacity, policy, time and budget checks remain active. The receipt follows durable operation progress; actual window cards use the opened result's seat, title, node name and budget, never a pending preview. The node identifier remains available as a tooltip. A supplied budget with no limits is unlimited; a missing pending budget remains unavailable. A created window is distinct from completed first-turn work; recorded opening failures remain visible.

## Dev Note

The existing seat engine owns approval mutations and durable operation progress; the UI only presents observations and submits explicit owner actions.

## Model Experience

### Confirmation and observation

#### What the model sees

Enabling `ui-seat-approvals` contributes no tools, prompts or Session messages. Approved work reaches models only through the existing engine executor.

#### Token effect

Queue and operation reads consume no model tokens. Admitted openings retain their existing model cost.

#### KV Cache effect

The surface does not modify request prefixes or refresh caches.

## Known Limitations and Deferred Work

- Scope is the current running node and authenticated owner, not arbitrary delegated or remote operator identities.
- Non-chain pending items can lack an authenticated node identifier. Missing budgets mean unavailable evidence, not zero or an invented quota.
- Observation is polling-based; queue snapshots may change between pages, and the engine's version comparison remains authoritative.
- Receipt selection is local to the mounted surface; closing it does not cancel or replay the durable operation.
- Physical opening, first-turn completion and source callback delivery remain separately observable engine outcomes.
