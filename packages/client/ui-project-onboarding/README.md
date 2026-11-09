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

The conversation overlay waits until the current welcome notice is acknowledged and the main Session is ready and no longer blank, then asks once per workspace path for Off, Remind only, or Automatic; Automatic is the initial draft, not an implicit approval, and may incur model charges after saving. A successful selection is stored in the product profile's `ui-project-onboarding.projects` dictionary, never in the user's project. The Project opening settings page lists existing workspaces and saved directories without requiring a project Session. It explains each mode and the Automatic default; selecting a mode saves it immediately. The page shows absolute profile configuration and JSON seat-catalog file and directory paths, with native open and reveal actions, and an explicitly refreshable Running, Recovering, or Unavailable engine observation. The catalog contains all local projects; a missing local provider or non-JSON backend has no local catalog file. Opening mode is the only project-specific adjustable preference; engine deployment parameters remain Host-owned. Read-only settings disable writes; failures retain the prior visible selection and offer retry.

The shared Panedesk header gives three first-use steps and marks mode changes as manual-only. Product preferences remain visible; engine observations and the seat catalog are collapsed into **Advanced (not needed on one machine)**.

The owner-only `projectOpening.select` operation resolves matching seat projects from the complete authorized local catalog, applies their engine policies with revision checks, then persists the product preference. A failed save attempts every restoration with the revision owned by that save, including the previous `modeChosen` flag. Concurrent winners are not overwritten; a concurrent restoration already matching the original fields counts as restored. Structured results and localized feedback report each project as restored, conflicted, or unknown after failure.

With no matching seat, the preference is stored without starting an engine. A lifecycle-owned synchronous resolver reads saved workspace choices inside the engine's first admission transaction, including newly imported seats. The policy and admission or disabled refusal commit together; no notification repairs the first decision afterward. Explicit project policies take precedence. Conflicting saved choices among a seat's directories refuse admission rather than selecting an arbitrary directory. Disposing the plugin removes the resolver, not previously committed policy.

Settings → Panedesk → Workflow edits the localized `workflowRequirementsPrompt`, `workflowSetupPrompt`, and `workflowCheckupPrompt` product preferences, with Save and Restore default for each prompt. Their defaults reference the built-in workflow-pack's `requirements-review.md`, `getting-started.md`, and `workflow-checkup.md` (the `.zh.md` versions in Chinese); setup requires Python 3.11 or newer. The project guide uses the saved setup prompt. The new-session screen offers optional requirements-review, workflow-setup, and workflow-checkup starters between the brand mark and composer. Selecting one inserts the saved prompt, persists the draft, and focuses the composer without sending or writing project files. After selection, Choose another clears the draft and restores the three starters. Typing before selection or sending a message hides the starters. The Workflow page owns `ui-project-onboarding.showWorkflowStarters`, default `true`; it controls only the central starters, not the upper-right menus.

Opening presets live in the default-empty `ui-project-onboarding.openingPresets` product setting. Settings → Panedesk → Opening presets displays the actual configuration path and opens it through the existing settings action. Its editor supports adding, editing, and deleting presets. Rows start collapsed, showing a handle, name, and first directory; expand a row to edit it. Only the handle drags, using the summary row as its preview and an insertion line at the drop position; Move up / Move down also reorder rows. Folder drops still add directories to the target row. Pasting two or more nonempty opening lines into a row replaces it with one preset per line in place, names each with the existing extraction rules, and uses inferred directories or that row's directories when none match. A notice above the list offers Undo to restore the pre-split draft. Single-line paste remains unchanged. Batch paste controls appear above the list and also accept markdown tables with `开窗目录`, `开窗句原文` / `开窗句(原文)`, and optional model and permission columns. Each saved row has a name, original prompt, and at least one directory. Desktop folder drops use the existing host-path bridge; Add folder uses the native chooser. Batch imports look for an existing registered workspace at or immediately inside the parent of the markdown file's containing directory; unmatched rows remain editable and cannot be saved without a directory. Names use General Settings' saved extraction or the containing folder, and are limited to twenty Unicode characters including an ellipsis.

The Opening menu occupies the former mode-picker position; the mode picker sits at the row's right edge. Current-directory presets lead, then other presets are grouped by their first directory; multiple target directories use a submenu when the current directory does not match. Selection reuses a blank session in the target workspace, replaces its draft without sending, applies optional model / permission overrides, and focuses the composer. Model text accepts a catalog model ID or `provider/model` and an optional effort after a space or ` / `; permission text is an installed `/permission` preset name. Omitted values leave the receiving session unchanged. The preset name is recorded through the existing title event at selection, with the existing opening-date and duplicate-name rules. The new-session screen places Opening presets and Workflow side by side above and to the right of the brand mark through `conversation.hero.actions`. Opening presets directly lists the same sorted choices, Add preset opens the editor with only the new first row expanded and existing rows collapsed below it, and Manage opens its settings section. Workflow offers the same three draft actions and a direct settings link. Both links reuse `settingsNavigation.openSection`; both menus remain available when central starters are disabled. Configuration editing and preset selection make no model request; configured model and permission changes apply when the user later sends.

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
