---
description: "Optional manual seat picker, seat browser and identity labels."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-seats

English | [中文](README.zh.md)

## Summary

Optional [seat](../../../docs/subsystems/seat.md) presentation for the new-session picker, sidebar section and occurrence-local header identity. The web composition keeps this plugin disabled until explicitly enabled; no internal seat names are embedded.

## Table of Contents

- [Use this package](#use-this-package)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

The authenticated owner reads definitions and existing-window status through `seatUi`. Manual opening calls the existing seat provider with `openingMode: 'prefill'`, preserving its directory, preset, model and permission stages without starting a model turn. The returned opening sentence initializes the draft and waits for user submission. Missing providers hide the picker and sidebar section; incomplete evidence disables opening.

An available but empty catalog keeps the Seats heading, empty message and Add seat action visible. Configure the Host's `home` with the absolute product home to enable source preparation. Add seat asks only for a name, an existing absolute working directory, a configured model and an opening sentence. Models come from the existing Session model catalog. The owner-only `seatUi.prepareAdd` handler creates a private, atomically published CSV snapshot inside that home, preserving the existing definitions and appending one row. The Client uses the existing `seats/import.preview` and `seats/import.commit` methods; it requires exactly one create row without diagnostics and commits only that row after confirmation. Adding does not open a window or send a model request. Directory, duplicate-name, model and import failures have localized recovery instructions; an uncertain commit outcome requires refreshing before another attempt.

Both opening entries confirm differing directories with profile, stay-here and cancel choices. Stay-here requests an exact registered directory for this opening only; an unregistered directory is refused with its reason and the profile-directory alternative, without expanding permissions or editing the profile. The picker receives the Session's current working-directory projection from its owner, or the pending workspace before a Session exists. The sidebar reads that same projection from the uniquely retained main-view Session; opening is disabled when several main views make the current directory ambiguous.

Business data uses a Client resource, refreshed by Session lifecycle notifications, engine diagnostic invalidations, connection resets and local opening results. Releasing its last holder or unloading the plugin cancels in-flight overview reads and removes refresh listeners. Header identity reads exact Session binding metadata independently of catalog and online failures. Verified seat and node or free-window identity remains visible with a separate degraded-state label; missing or rejected evidence explicitly shows loading or failure, never an inferred free window or another Session's binding. The sidebar expands existing windows and displays their current seat status rather than adding another busy-state API. Refusals use the shared Toast primitive, including the Session-resource-authorized memory-denial event, which is displayed only in its matching Session.

The expanded sidebar is the single location for localized engine, absent-opening and live-model alerts, with wrapping and a scrollable height limit. The collapsed sidebar shows a warning icon only while diagnostics exist; activating it expands the sidebar to the complete alerts, including when the catalog is empty. With no diagnostics it adds no collapsed entry. The cold picker and header do not repeat those alerts. Missing-preset diagnostics name the retained preset and refusal code; restoring the preset and successfully opening that seat clears the alert, while the failed intent remains auditable. Retryable engine alerts clear only after a complete successful recovery round; stopped engines require repair and host restart. Continuous unavailability exceeding ten minutes adds a localized alert in the same area, directing the owner to the host log; it clears when the engine returns to running. Invalidations carry no diagnostics; every overview read still requires owner authority. Opening refusals also reach the cold picker without a Session header. Model-unavailable alerts name the seat, provider and model, state that other seats continue, and direct the user to restore the model and resend in that Session; successful model configuration clears an opening alert without replaying the original opening. Live-turn alerts clear after a completed resend or disposal of that runtime; they do not change the turn's error classification.

## Dev Note

The seat provider owns opening policy and Session identity; the Client resource owns observation refresh and cancellation. Both opening entries share the package-local directory confirmation. Published runtime entries use the bundled Host and Client files; the types-only entry publishes declarations without unbundled Client modules.

## Model Experience

### Manual seat selection

#### What the model sees

Selecting a seat with `openingMode: 'prefill'` creates no model request. The opening draft becomes model-visible only after the user submits it; denied writes retain their coded tool result.

#### Token effect

Picker, sidebar, identity and Toast content add no model tokens. A submitted opening sentence and tool refusal text consume their normal input/result tokens.

#### KV Cache effect

UI selection and transient notices do not alter existing model prefixes.

## Known Limitations and Deferred Work

- Stay-here supports only exact registered seat directories; it cannot grant a new directory.
- The occurrence-local label occupies a separate `conversation.header.seat` slot inside the leading area; the existing root-scoped leading slot has no Session identity and is unchanged.
- Existing-window conflicts require selecting a window from the sidebar; replace/cancel workflows are not implemented here.
- Seat catalog changes without a Session notification require reopening the resource. No polling interval or parallel catalog cache is introduced.
