---
description: "Opt-in single-seat messages and local online observations."
kind: "package-reference"
---

# @panedesk/dsh-tool-seat-messages

English | [中文](README.zh.md)

## Summary

Send a message to one open local seat or inspect online seat windows. This optional plugin uses [local message delivery](../message-delivery-local/README.md) and [seat observations](../../seat/seat-local/README.md); it never opens a seat or broadcasts.

## Table of Contents

- [Use this package](#use-this-package)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Mount `@panedesk/dsh-tool-seat-messages` with `tools`, `agents`, `messageDelivery` and `seatLocalRead`. Explicitly set `seatAddressing: true` on the local message provider. Installing the full dependency carrier does not mount the tools or change existing delivery defaults.

A live calling Session supplies sender identity: a bound seat signs with its seat name; an unbound Session signs with its title and the label `Free window`. Model arguments cannot select the sender. Sending uses durable `handoff` with `steer` priority: a busy recipient receives input at its next tool-step boundary, and an idle recipient starts a turn when its handoff wake policy permits. Existing receive policies and legacy queue timing remain unchanged.

Exact local seat names select a unique current primary window. Unopened seats return `seat not open`; ambiguous selections return their reason and candidate Sessions. Online observations include seat, Session, node, busy/idle status and primary selection. Unknown liveness fails instead of being reported as idle.

## Dev Note

Tool registrations are disposed with their plugin scope. No Session or message-ledger format changes are required.

## Model Experience

### Single-seat tools

#### What the model sees

`seat_send` accepts `seat`, `text` and optional `node`; `seat_list_online` takes no arguments. Results are JSON rendered as text, and the generic tool card presents arguments and results. Attributed message text enters the recipient's persisted user-message history. Delivery and reading use the existing message ledger.

#### Token effect

Tool schemas, call results and delivered message text consume tokens. Online queries do not start recipient turns.

#### KV Cache effect

Tool availability changes schema context. Delivery appends history without rewriting prior model-visible messages.

## Known Limitations and Deferred Work

- Optional `node` selects one configured remote node identity; omission preserves local addressing. Remote sending and observation require explicit delegated permission and compatible node-link providers. Wildcards and group sending are unavailable. Remote refusals preserve `target-not-found`, `offline` and `busy-not-accepting`, with English and Chinese explanations. `seat_list_online` includes unreachable nodes as `status: 'unknown'`, not an empty successful snapshot.
- Online state is an observation, not a reservation: a recipient can close between resolution and durable send. If the send observes closure and the recipient still has durable Session metadata, the existing mailbox retains queued mail and returns `target-closed-pending` with `pending: true`; this is not delivery or reading, and the tool does not reopen the recipient. An empty Session that closes without durable metadata can instead return `target-not-found` without queuing mail. Admission and reading are reported only by the recipient's subsequent message-ledger receipts.
- A repeated tool call uses the same operation identity; changed target or attribution can be rejected as an operation conflict rather than sent twice.
- Recipient policies may reject messages or disable idle wake.
