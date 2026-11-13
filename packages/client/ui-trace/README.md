---
description: "Right-sidebar project items and decisions, plus workspace recording switches."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-trace

English | [中文](README.zh.md)

## Summary

The Panedesk features page carries the workspace switches for project recording. Its workspace menu opens on the workspace of the session shown in the main view, and on the first workspace when none is shown. A right-sidebar tab lists that workspace's items, their activity, unassigned activity, and decisions. Recording stays off until the user turns it on. The tab reads and writes only through the `traceStore` remote; it keeps no record of its own.

## Use this package

The settings row offers item recording, a link to an existing project, and strict mode. Successful changes show a saved notice; failed reads and actions in settings or the panel show the original service error. Strict mode can be changed only while recording is on, and it names one planning window from the workspace's own sessions. A session-header button opens `dsh-resource://trace/session/<sessionId>` as the `trace` tab kind. While recording is off the tab shows only a short note and a button that opens the Panedesk features page. The items page lists open and closed items, creates an item, shows the selected item's timeline, assigns checked unassigned activity, closes an item, and downloads the selected item as JSON or Markdown. Each activity row is one sentence that names its window by the first eight characters of the session id; its stored type is the row tooltip. The selected item's timeline and unassigned activity reread every three seconds while shown, so new activity appears without leaving the page, and the close and export buttons sit above the timeline. Unassigned activity scrolls with the newest entries first, and the assign button names its target and stays disabled when nothing can be assigned. Turning item recording on or off shows its notice next to the switch. Activity summaries include reply or command previews and changed file names. Each reference button expands or collapses wrapped, scrollable diff lines or up to 4000 characters of stored reply text directly beneath its activity; reply previews use the first 30 characters without reasoning. Export preserves Chinese and other legal filename characters and immediately shows a notice beside the export controls until the next panel operation. Desktop reports the exported filename after writing finishes, or reports cancellation. The decisions page follows saved strict-mode changes and refreshes after committed decision writes, lists current entries with their window, model, and time, and offers reversion only for entries not already reverted. Current entries use the originating window and model even after user confirmation; the immutable audit revision still records the user operation. History labels rejected proposals as rejected and shows its empty notice only once. Pending proposals and their confirm and reject buttons appear only while strict mode is on; the planning-window menu has a bounded, scrollable list.

## Model Experience

### Project trace panel

#### What the model sees

Nothing. The panel and the settings row are user-facing. This package adds no tool and no prompt text.

#### Token effect

Opening the panel adds no model request. Recording itself adds none either.

#### KV Cache effect

The panel does not change model input or cache reuse.

## Known Limitations and Deferred Work

- The tab shows the workspace that owns the on-screen session. A session with no workspace shows the off-state note.
- Ordinary Web starts a browser download and keeps the exporting notice because the browser exposes no completion or cancellation result. Desktop uses its owned save dialog and writes only to the chosen destination.
- Timeline pages use the service default page size. Current decisions and history share one live revision list.
- The panel does not offer voiding an item.

## Dev Note

`src/index.ts` is the empty host half. `src/client/index.ts` mounts `traceStore` and registers the settings row and the sidebar tab. Both faces call only that remote.
