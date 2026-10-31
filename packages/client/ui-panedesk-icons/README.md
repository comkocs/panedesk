---
description: "Static browser glyphs and design tokens."
kind: "package-library"
---

# @panedesk/dsh-client-ui-panedesk-icons

## Summary

Static icon and token library for the Panedesk entry surfaces: the self-drawn monoline glyph set (16/20/24, currentColor), the application mark, and the design-token table that records which upstream DSH theme variables the new panels consume plus the one new spacing tier.

English | [中文](README.zh.md)

## Table of Contents

- [Using this package](#using-this-package)
- [Token table](#token-table)
- [Icon manifest](#icon-manifest)
- [Understanding the implementation](#understanding-the-implementation)
- [Further reading](#further-reading)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Using this package

Import glyph components directly (`import { IconPanedeskStats } from '@panedesk/dsh-client-ui-panedesk-icons'`); this is a static browser library like ui-primitives — no plugin half, no slots, no bundle step. Every glyph inherits its color from `currentColor` and renders at `size` 16 (default), 20, or 24 on one 24-unit grid with a 1.5-unit stroke.

## Token table

The durable home of the table is [`src/tokens.ts`](src/tokens.ts); this section is the human-readable projection. The public `./tokens` entry resolves to the emitted `lib/types/tokens.js`; its declarations use the adjacent `.d.ts` file.

- **Color** — the new surfaces consume upstream semantic aliases only: `--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1/2`, `--dsw-alias-border-l2/l3`, `--dsw-alias-label-primary/secondary/tertiary`, `--dsw-alias-brand-primary`, `--dsw-alias-menu-icon`. Values live in `packages/client/ui-theme/src/styles/design-platform.css`; this package mints no color values.
- **Font** — `--dsw-font-base-16`, `--dsw-font-s-14`, `--dsw-font-m-18`, `--dsw-font-l-20` (defined in `packages/client/ui-theme/src/styles/gradient-shadow-text.css`).
- **Radius** — `--dsw-radius-xs/sm/md/lg` (defined in `packages/client/ui-theme/src/styles/base.css`).
- **Spacing — new tier** — the upstream theme ships no unified spacing variables, so `PANEDESK_SPACE` names the 4px steps the new panels already use in their CSS Modules: `x1=4, x2=8, x3=12, x4=16, x6=24`.

A drift guard (`tests/tokens.client.spec.ts`) fails when a referenced upstream variable no longer exists in the recorded file, and `pnpm run scan:colors` (plus the same spec) fails on any hardcoded color literal under `src/` outside the token table itself.

## Icon manifest

| Name | Entry surface (design §2 placement table) | Sizes | Source / license |
|---|---|---|---|
| `app` | Application mark for Panedesk surfaces | 16/20/24 | Self-drawn (this package, MIT, same as the repo) |
| `stats` | Settings stats desk section + main panel header | 16/20/24 | Self-drawn |
| `workflow` | Workflow panel entries | 16/20/24 | Self-drawn |
| `subagent-tree` | Session-header pill + right-rail tab | 16/20/24 | Self-drawn |
| `node` | Settings nodes section | 16/20/24 | Self-drawn |
| `seat-grid` | Seats overview hover affordance + row menu | 16/20/24 | Self-drawn |
| `seat-profile` | Settings seat-profiles section | 16/20/24 | Self-drawn |
| `inbox` | Session-header receipt/quarantine pill | 16/20/24 | Self-drawn |
| `bash` | Windows Git Bash settings row | 16/20/24 | Self-drawn |

Everything self-drawn: no third-party icon set is embedded, so no THIRD_PARTY_NOTICES entry is required. Entries whose needs an upstream `ui-primitives` icon already covers (pin, ellipsis, warning, refresh, skill, plugin, gauge-adjacent shells) reuse the upstream icons and are deliberately absent here. The registry is capped at 24 glyphs by test.

## Understanding the implementation

### Design notes

One shared `Glyph` frame keeps the stroke, joins, caps, and decorative role (`aria-hidden`) identical across the set, so a glyph file only states its geometry. The registry doubles as the manifest source so the tests can enforce the budget and size coverage without a second list to keep alive.

### Source map

- `src/glyphs.tsx` — glyph components, app mark, and the manifest registry.
- `src/tokens.ts` — the token table (upstream references + the new spacing tier).
- `scripts/scan-color-literals.mjs` — the color-literal scan (token table exempt by filename).

## Further reading

- [`@panedesk/dsh-client-ui-primitives`](../ui-primitives/README.md) — the upstream icon set the other entries reuse.
- [`ui-theme` styles](../ui-theme/src/styles/design-platform.css) — the upstream token values this table references.

## Model Experience

### User interface

#### What the model sees

This package changes no model input or output.

#### Token effect

UI and configuration operations consume no model tokens.

#### KV Cache effect

No model calls are involved; no KV-cache impact.

## Known Limitations and Deferred Work

- **Glyphs unused until their lanes land** — the manifest covers every planned entry this package owns; the integration sweep should re-check each entry still matches its landed surface before wider reuse.
- **Spacing tier is names, not CSS variables** — the theme owns no spacing variables, so consumers use `PANEDESK_SPACE` values directly; promoting them into `ui-theme` is upstream work.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer working context — click to expand</summary>

Adding a glyph: draw on the 24 grid, add the component and one registry row, and the size/budget/color tests pick it up. The scan script and the drift guard need no per-glyph changes.

</details>
