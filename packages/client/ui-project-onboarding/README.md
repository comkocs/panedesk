---
description: "Project-scoped opening preferences and workflow-pack guidance in the Web client."
kind: "package-reference"
---

# Project opening guidance

English | [中文](README.zh.md)

## Summary

Session-only project guidance and a custom product settings page. Part of the [Web client subsystem](../../../docs/subsystems/web-client.md).

## Table of Contents

- [Behavior](#behavior)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="behavior"></a>
## Behavior

The conversation overlay waits until the current welcome notice is acknowledged and the main Session is ready and no longer blank, then asks once per workspace path for Off, Remind only, or Automatic; Remind only is the initial draft, not an implicit approval. A successful selection is stored in the product profile's `ui-project-onboarding.projects` dictionary, never in the user's project. The Project opening settings page lists existing workspaces and saved directories without requiring a project Session. It explains each mode and the Remind only default; selecting a mode saves it immediately. The page shows absolute profile configuration and JSON seat-catalog file and directory paths, with native open and reveal actions, and an explicitly refreshable Running, Recovering, or Unavailable engine observation. The catalog contains all local projects; a missing local provider or non-JSON backend has no local catalog file. Opening mode is the only project-specific adjustable preference; engine deployment parameters remain Host-owned. Read-only settings disable writes; failures retain the prior visible selection and offer retry.

The shared Panedesk header gives three first-use steps and marks mode changes as manual-only. Product preferences remain visible; engine observations and the seat catalog are collapsed into **Advanced (not needed on one machine)**.

The owner-only `projectOpening.select` operation resolves matching seat projects from the complete authorized local catalog, applies their engine policies with revision checks, then persists the product preference. A failed save attempts every restoration with the revision owned by that save, including the previous `modeChosen` flag. Concurrent winners are not overwritten; a concurrent restoration already matching the original fields counts as restored. Structured results and localized feedback report each project as restored, conflicted, or unknown after failure.

With no matching seat, the preference is stored without starting an engine. A lifecycle-owned synchronous resolver reads saved workspace choices inside the engine's first admission transaction, including newly imported seats. The policy and admission or disabled refusal commit together; no notification repairs the first decision afterward. Explicit project policies take precedence. Conflicting saved choices among a seat's directories refuse admission rather than selecting an arbitrary directory. Disposing the plugin removes the resolver, not previously committed policy.

The workflow-pack action inserts the new-project `/workflow-pack` request into the current composer and persists the draft without submitting a message or writing project files. The new-session screen offers optional starters for a new project, a documented project, or an existing project between the brand mark and composer. Selecting one fills and focuses the composer; the documented-project starter selects its path placeholder. Starters hide when the user types or sends a message and never appear in conversations with messages. The Panedesk feature setting `ui-project-onboarding.showWorkflowStarters` controls their visibility and defaults to `true`.

Opening presets live in the default-empty `ui-project-onboarding.openingPresets` product setting. Settings → Panedesk → Opening presets displays the actual configuration path and opens it through the existing settings action. Its editor supports adding, editing, deleting, card drag sorting, multiline opening text, and markdown tables with `开窗目录`, `开窗句原文` / `开窗句(原文)`, and optional model and permission columns. Each saved row has a name, original prompt, and at least one directory. Desktop folder drops use the existing host-path bridge; Add folder uses the native chooser. Batch imports look for an existing registered workspace at or immediately inside the parent of the markdown file's containing directory; unmatched rows remain editable and cannot be saved without a directory. Names use General Settings' saved extraction or the containing folder, and are limited to twenty Unicode characters including an ellipsis.

The Opening menu occupies the former mode-picker position; the mode picker sits at the row's right edge. Current-directory presets lead, then other presets are grouped by their first directory; multiple target directories use a submenu when the current directory does not match. Selection reuses a blank session in the target workspace, replaces its draft without sending, applies optional model / permission overrides, and focuses the composer. Model text accepts a catalog model ID or `provider/model` and an optional effort after a space or ` / `; permission text is an installed `/permission` preset name. Omitted values leave the receiving session unchanged. The preset name is recorded through the existing title event at selection, with the existing opening-date and duplicate-name rules. A blank session's header also offers quick selection and the same editor. Configuration editing and preset selection make no model request; configured model and permission changes apply when the user later sends.

<a id="dev-note"></a>
## Dev Note

Host preferences and seat policy synchronization live in `src/index.ts` and `src/opening.ts`; the Client entry lives in `src/client/`. Client reads and invalidations use the shared settings describe mirror; successful selection replies fold back into it without a separate describe request.

<a id="model-experience"></a>
## Model Experience

### Project guidance

#### What the model sees

Viewing or saving `ui-project-onboarding.projects` preferences adds no model context. The workflow-pack action changes only a human-visible draft until the user sends it.

#### Token effect

Viewing or saving preferences makes no model request and consumes no model tokens. Automatic mode may permit subsequent rule-driven model work.

#### KV Cache effect

The package does not change prompt prefixes or retained model history before the user submits a draft.

## Known Limitations and Deferred Work

- Workspace keys are host directory paths; aliases and symlinks are not merged. Seat projects sharing an exact directory receive the same explicit selection.
- Product persistence and engine journals are separate stores. A reported rollback conflict requires manual policy review; no cross-store atomicity is claimed.
