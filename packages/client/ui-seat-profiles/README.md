---
description: "Owner-only seat profile settings and mapped Markdown or CSV imports."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-seat-profiles

English | [中文](README.zh.md)

## Summary

This optional plugin adds Seat profiles to Settings without adding a cold-start sidebar entry. The authenticated owner can inspect and edit the local [seat](../../seat/seat-local/README.md) catalog, confirm definition deletion, and preview selected rows from a mapped Markdown or CSV source.

Settings actions use shared outlined buttons; Save and import commit use the primary style.

## Table of Contents

- [Use this package](#use-this-package)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Enable both plugin faces with the local seat provider, Settings shell, resources, locale and Remote services. Seat-row navigation opens this section through `seatProfilesNavigation`; withdrawing the section removes that navigation service. Client configuration accepts optional `presets` entries with `id`, localized `label` and a `columnMap`; product-specific header names belong in product configuration, not the parser.

The shared Panedesk header marks profile maintenance as manual-only; the existing controls are collapsed under **Advanced (not needed on one machine)**.

Select a seat to stage edits. Workspaces, memory directories, opening text or file, charter / opening required files, agent preset, provider, model, reasoning effort, permission preset, platform and node are editable. Opening rules and other limits appear under a collapsed disclosure. Structured values use JSON; seat identity, schema version and import metadata remain unchanged. Saving advances the definition revision and submits the observed catalog revision. A conflict preserves the draft; explicit Refresh discards it and reloads current values. A successful save advances the local editing revision for the next save.

Source-owned catalogs require a separate owner confirmation to transfer the entire catalog to local editing. This uses the existing audited authority operation; save and delete never transfer ownership implicitly. Deletion displays open windows and pending approvals before confirmation, marks a window with unknown state as state unknown (resume required), and refuses that deletion with `evidence-unavailable` until the window is opened from the session list and resumes. It removes only the definition, and neither closes windows nor cancels approvals. Existing work that still needs that definition can subsequently refuse with `seat-not-found`; review that impact before deletion.

Import reads a Host source path. A refused save, deletion, transfer, preview or import shows the localized seat refusal and its remedy, including `seat-store-authoritative` and `import-source-authoritative`; an unrecognized refusal code stays visible beside the generic unknown-error text. Choose Markdown or CSV, optionally name a Markdown table, supply a JSON header-to-field mapping and complete definition defaults, then Preview. No row is selected automatically. Invalid, conflicting and unchanged rows cannot be selected; row diagnostics and local/source differences remain visible. Commit submits only selected row numbers through the existing preview/commit protocol. Changing source, mapping or defaults clears the preview. A selected profile can supply defaults, but source identities still require explicit mapping. See the [local provider](../../seat/seat-local/README.md) for mapping conversions, source freshness and CAS behavior.

A timeout or disconnected write blocks saving, deletion and import submission until Refresh obtains a new live observation; clicking Refresh alone does not unblock them. Identical requests retain their operation identity for host-side replay without applying the same write twice.

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
- Definition deletion and engine activity use distinct storage transactions. Confirmation includes window and approval state versions. The Host checks the catalog revision, writes the deletion, then checks the relevant engine impact inside the journal queue. A failed following check restores the previous catalog at a newer revision before releasing the catalog queue. This is not an atomic cross-store transaction: process termination or a failed compensation write requires recovery and a fresh observation.
- Resource withdrawal cancels its Remote observation and removes invalidation listeners; it does not undo an already accepted catalog write.
- Host source files must already exist and be readable. The browser does not upload files or infer missing model, node, preset or permission defaults.
