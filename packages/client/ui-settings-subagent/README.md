---
description: "Subagent delegation depth and capacity settings on the Plugins page."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-settings-subagent

English | [中文](README.zh.md)

## Summary

Open **Plugins** and select **Subagent** to configure delegation depth and parallel capacity. Model selection is always available from the configured catalog and has no permission switch or separate allowlist.

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

**Limits** holds **Maximum recursion depth** and **Subagent parallelism limit** side by side, stacking on narrow screens; the information button beside each label discloses its rule — a two-row depth example, and the count that capacity bounds — and a draft that is not a whole number in range blocks the save and says so under the field. Depth yields to a tool's own maximum; capacity counts every live subagent under one main agent across all levels, the main agent excluded.



**Save** writes the limits through the `subagent` namespace using the revision read by the draft. A rejected write remains visible for correction; leaving the page discards drafts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host entry serves the browser plugin. `SubagentLimitsCardController` binds `subagent` through `ctx.configForms.get` and stages limits in the shared `SettingsFormModel`. `SubagentCard` renders its framework-bound snapshot and save/discard actions. `ctx.configForms.whileServed` registers the Plugins page item only while that namespace is served.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-plugin-manager](../ui-plugin-manager/README.md) — the Plugins page and the `plugins.item` slot the page registers into.
- [ui-settings](../ui-settings/README.md) — the settings scope and the served-namespace watch the page rides.
- [ui-primitives](../ui-primitives/README.md) — the settings form model and fields the limits section renders.
- [tool-subagent](../../subagent/tool-subagent/README.md) — delegation and live model selection.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Tool-specific depth limits take precedence over the Host default shown here.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
