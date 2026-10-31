---
description: "Owner-only seat profile settings and mapped Markdown or CSV imports."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-seat-profiles

English | [中文](README.zh.md)

## Summary

This optional plugin adds Seat profiles to Settings without adding a cold-start sidebar entry. The authenticated owner can inspect and edit the local [seat](../../../../docs/subsystems/seat.md) catalog, confirm definition deletion, and preview selected rows from a mapped Markdown or CSV source.

## Use this package

Enable both plugin faces with the local seat provider, Settings shell, resources, locale and Remote services. Seat-row navigation opens this section through `seatProfilesNavigation`; withdrawing the section removes that navigation service. Client configuration accepts optional `presets` entries with `id`, localized `label` and a `columnMap`; product-specific header names belong in product configuration, not the parser.

Select a seat to stage edits. Workspaces, memory directories, opening text or file, charter / opening required files, agent preset, provider, model, reasoning effort, permission preset, platform and node are editable. Opening rules and other limits appear under a collapsed disclosure. Structured values use JSON; seat identity, schema version and import metadata remain unchanged. Saving advances the definition revision and submits the observed catalog revision. A conflict preserves the draft; explicit Refresh discards it and reloads current values. A successful save advances the local editing revision for the next save.

Source-owned catalogs require a separate owner confirmation to transfer the entire catalog to local editing. This uses the existing audited authority operation; save and delete never transfer ownership implicitly. Deletion displays open windows and pending approvals before confirmation, removes only the definition, and neither closes windows nor cancels approvals. Existing work that still needs that definition can subsequently refuse with `seat-not-found`; review that impact before deletion.

Import reads a Host source path. Choose Markdown or CSV, optionally name a Markdown table, supply a JSON header-to-field mapping and complete definition defaults, then Preview. No row is selected automatically. Invalid, conflicting and unchanged rows cannot be selected; row diagnostics and local/source differences remain visible. Commit submits only selected row numbers through the existing preview/commit protocol. Changing source, mapping or defaults clears the preview. A selected profile can supply defaults, but source identities still require explicit mapping. See the [local provider](../../seat/seat-local/README.md) for mapping conversions, source freshness and CAS behavior.

## Dev Note

The Host adapter checks live owner invocation before accessing `seatProfilesLocal`. Components receive framework resource/store props and plain callbacks. Profile selection belongs to the settings-section store; staged edits and import selection belong to their mounted component.

## Model Experience

### Profile maintenance

#### What the model sees

Editing, deleting and importing definitions sends no model request. Later openings use the accepted `opening` and `openingInstructionFiles` values through the existing seat opening flow; existing Session messages are not rewritten.

#### Token effect

Forms, previews and receipts add no model tokens. Opening instructions consume their normal input tokens only when an opening is submitted.

#### KV Cache effect

Profile maintenance does not replace existing Session prefixes or invalidate an active model cache.

## Known Limitations and Deferred Work

- JSON fields require complete valid structured values; this editor does not provide a directory picker or natural-language model parser.
- Definition deletion and engine activity use distinct storage transactions. Confirmation rechecks observed impact and engine sequence before the catalog mutation, but does not lock future engine activity throughout catalog persistence.
- Resource withdrawal cancels its Remote observation and removes invalidation listeners; it does not undo an already accepted catalog write.
- Host source files must already exist and be readable. The browser does not upload files or infer missing model, node, preset or permission defaults.
