---
description: "The composer cache pill: remaining cache time for the main window and its subagents, and an explicit-route tier switch that takes effect on the next request."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-cache-pill

English | [中文](README.zh.md)

## Summary

This package adds one composer dock pill after the shipped activity and usage pills. Opening it lists the cache time left for the main window and each authorized descendant with ledger evidence. An explicit cache route also offers the tiers that route supports; an automatic route lists hits only and offers no switch. A stored tier is carried by the next request of that window. A window without cache evidence shows unknown rather than a guessed duration.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside `ui-conversation`. The pill appears in the composer dock of an open session except with the minimal preset, and stays off the screen shown before a session starts. The closed pill shows the main window's reading. The open panel sits above the whole composer without covering its input card or toolbar, and lists the main window and each authorized descendant with ledger evidence. Only an explicit route shows tier buttons, and only the tiers that route supports. Choosing one stores it; the following request of that window carries it.

### Failures

A read failure, an empty record, and a deployment without a cache ledger each show their own line. A tier the route does not support is refused before anything is stored, and the panel says the switch failed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package contributes the `cache` entry (order 2) of `conversation.composer.dock`. The browser calls `cacheView.read` and `cacheView.setTier` on the cache-owned Remote. Those methods read `llmCache.remaining`, `llmCache.routeFor`, and `llmCache.policy`, and store a tier through `llmCache.update`. The next `agent/request` of that window writes the stored policy into the request. Remaining seconds are the ledger estimate rounded to a whole second. Descendants come from ledger parent identities and are filtered individually through the caller grants. A shared session resource refreshes evidence every four seconds; the component decrements complete second-resolution readings locally.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-llm-cache](../../llm/llm-cache/README.md) — the policy table, the remaining-time estimate, and the request that carries a stored tier.
- [ui-conversation](../ui-conversation/README.md) — declares the composer dock.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the pill only reads cache evidence and stores the next request’s cache policy without adding model-visible content.

#### KV Cache effect

None. Displaying the remaining time and storing a tier do not change the model-visible history. The stored tier changes only the cache control of a later request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current pill. They are current package constraints, not a backlog.

- **Remaining time is an estimate** — a window without evidence shows unknown. The pill does not invent a duration, and the shown seconds can differ from the ledger by the rounding of one second.
- **Ledger-discovered descendants** — children without ledger linkage cannot be enumerated. Incomplete ledger snapshots are visibly marked partial and do not claim a complete descendant list.
- **The switch waits for the next request** — storing a tier does not send a request, and a request already in flight keeps the tier it was sent with.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
