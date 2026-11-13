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

Settings → Panedesk → Workflow edits the localized `workflowRequirementsPrompt`, `workflowSetupPrompt`, and `workflowCheckupPrompt` product preferences, with Save and Restore default for each prompt. Their defaults reference the built-in workflow-pack's `requirements-review.md`, `getting-started.md`, and `workflow-checkup.md` (the `.zh.md` versions in Chinese); setup requires Python 3.11 or newer. The project guide uses the saved setup prompt. The blank-session screen centers the optional requirements-review, workflow-setup, and workflow-checkup starters and their heading above the welcome headline through `conversation.hero.starters`. Selecting one inserts the saved prompt, persists the draft, and focuses the composer without sending or writing project files. After selection, Choose another stays above the composer, clears the inserted draft, and restores the three starters; the upper-right workflow menu's inserted prompts also expose this action. Typing before selection or sending a message hides the starters. The Workflow page owns `ui-project-onboarding.showWorkflowStarters`, default `true`; it controls only the central starters, not the upper-right menus.

Opening presets live in the default-empty `ui-project-onboarding.openingPresets` product setting. Settings → Panedesk → Opening presets displays the actual configuration path and opens it through the existing settings action. Its Add / Edit control shares initialization with the upper-right Add preset entry: neither creates a blank card on open, and an empty list shows an empty-state sentence and Add preset. Outside clicks keep the editor open; use its close button or Escape to dismiss it. Actions use content-sized standard buttons. The editor supports adding, editing, and deleting presets, including entries already stored in the profile. Successful saves keep the editor open and show “Saved N presets” beside Save for four seconds, immediately updating the settings list, reopened editor, and new-session Opening menus; saved rows remain available after restart. Rows start collapsed, showing a handle, name, first directory, and an accessible Delete icon; expand a row to edit it. Only the handle drags, using a narrow translucent bar as its preview and an insertion line at the drop position; Move up / Move down also reorder rows. Each row displays one folder path beside Change folder; the native chooser and folder drops replace that path, taking only the first dropped folder. Pasting two or more nonempty opening lines into a row replaces it with one preset per line in place, names each with the existing extraction rules, and uses inferred directories or that row's directories when none match. A notice above the list offers Undo to merge the pasted lines back into the original opening field, retaining its folder or the first inferred folder. Batch imports scroll to the first added row and show “Added N presets” beside Batch paste for four seconds. Single-line paste remains unchanged. Batch paste controls appear above the list and also accept markdown tables with `开窗目录`, `开窗句原文` / `开窗句(原文)`, and optional model and permission columns. Each saved row has a name, original prompt, and exactly one directory in the existing `directories` array; editing an older multi-directory row retains its first directory. Desktop folder drops use the existing host-path bridge; Change folder uses the native chooser. A missing folder is inferred from a path written in that opening when the field loses focus. Batch paste uses the folder written in each line; a line that names no path uses the current session's workspace directory, while table rows without a directory remain editable and cannot be saved. Manual additions and imports share General Settings' saved name extraction, then the containing folder or opening text, limited to twenty Unicode characters including an ellipsis.

The Opening menu occupies the former mode-picker position; the mode picker sits at the row's right edge. Current-directory presets lead, then other presets are grouped by their first directory; multiple target directories use a submenu when the current directory does not match. Selection reuses a blank session in the target workspace, replaces its draft without sending, applies optional model / permission overrides, and focuses the composer. The editor loads provider / model choices from `session.modelCatalog()` and permission choices from `permissionPresets.catalog().options`, with Follow current first in both menus. The model menu lists each provider/model ID once and adds the model ID to names that repeat within a provider; saved aliases remain readable. Models with reasoning efforts expose an adjacent menu starting with Default. New model selections use `provider/model` with an optional ` / effort`; permission selections store the catalog's stable `value`. Existing model IDs and space-separated efforts remain readable. Omitted values leave the receiving session unchanged. The preset name is recorded through the existing title event at selection, with the existing opening-date and duplicate-name rules. The new-session screen places Opening presets and Workflow side by side above and to the right of the brand mark through `conversation.hero.actions`. Opening presets directly lists the same sorted choices, Add preset opens the editor with existing rows collapsed and no new blank card, and Manage opens its settings section. Workflow offers the same three draft actions and a direct settings link. Both links reuse `settingsNavigation.openSection`; both menus remain available when central starters are disabled. Configuration editing and preset selection make no model request; configured model and permission changes apply when the user later sends.

Subagent presets appears to the left of Opening presets on the new-session screen and shares an aligned, responsive form with Settings → Panedesk → Subagent presets. The default-enabled `ui-project-onboarding.subagentPresets` object stores editable complexity criteria for Tiers A, B, and C and an initially empty ordered `models` list per tier. Each entry contains `provider`, `model`, `effort`, and `size` (`all`, `large`, `medium`, or `small`). Older single-model choices become the first `all` entry on read; saving writes only the new tier fields. Each tier has a criteria row, compact model and effort menus with Add, and removable model chips below. Model and effort menus read `session.modelCatalog()` when opened; an unspecified model disables effort and Add, and model changes reset effort to Default. Optional `sizes` rules are bilingual and editable, with `enabled` defaulting to false; enabling them adds a size menu and groups chips by large, medium, and small, with `all` entries applying to every group. Disabling sizes retains choices and rules but displays one model list. Eight default-checked main-session duties wrap horizontally with text before each checkbox; unchecked duties go to subagents. Additional main duties and default-enabled read-only nested delegation conditions remain editable. Save and Restore default persist the complete form and show a receipt beside the buttons. Editing uses the current UI language and saving records it for the Host prompt; before the first save, the Host uses Chinese. Preferences are per user, not per project, and do not alter tool dispatch or enforce classification.

<a id="dev-note"></a>
## Dev Note

Host preferences and seat policy synchronization live in `src/index.ts` and `src/opening.ts`; the Client entry lives in `src/client/`. Client reads and invalidations use the shared settings describe mirror; successful selection replies fold back into it without a separate describe request. Preset settings, editors, and selectors share one `configForms` instance; preset schemas use serializable fields because the Client validates the mirrored values after rehydrating the schema.

<a id="model-experience"></a>
## Model Experience

### Project guidance

#### What the model sees

Viewing or saving `ui-project-onboarding.projects` preferences adds no model context. The workflow-pack action changes only a human-visible draft until the user sends it. When subagent presets are enabled, the Host's `ui:subagent-presets` system section reads current saved preferences at each assembly: main sessions receive tier criteria, ordered model preferences, and duty allocation, while sessions with `origin: subagent` receive only nested delegation rules. Multiple models are listed in priority order. Enabled size rules precede the tier-by-size model lists; an empty list lets the model choose according to the task. Delegation uses the `subagent` tool's `provider`, `model`, and optional `effort` parameters. Turning the preference off removes the section on the next request.

#### Token effect

Viewing or saving preferences makes no model request and consumes no model tokens. Automatic mode may permit subsequent rule-driven model work. Enabled delegation guidance adds the role-specific section's text to subsequent requests.

#### KV Cache effect

Workflow drafts do not change prompt prefixes before submission. Saving delegation preferences changes the role-specific system section on the next request and may invalidate the cached prefix from that section onward; it does not rewrite retained history.

## Known Limitations and Deferred Work

- Workspace keys are host directory paths; aliases and symlinks are not merged. Seat projects sharing an exact directory receive the same explicit selection.
- Product persistence and engine journals are separate stores. A reported rollback conflict requires manual policy review; no cross-store atomicity is claimed.
