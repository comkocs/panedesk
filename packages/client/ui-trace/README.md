---
description: "Right-sidebar project items and decisions, plus workspace recording switches."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-trace

English | [中文](README.zh.md)

## Summary

The Panedesk features page carries the workspace switches for project recording. Its workspace menu opens on the workspace of the session shown in the main view, and on the first workspace when none is shown. A right-sidebar tab lists that workspace's items, their activity, unassigned activity, and decisions. Recording stays off until the user turns it on. The tab reads and writes only through the `traceStore` remote; it keeps no record of its own.

## Use this package

The settings row offers item recording, a link to an existing project, and strict mode. Successful changes show a saved notice; failed reads and actions in settings or the panel show the original service error. Strict mode can be changed only while recording is on, and it names one planning window from the workspace's own sessions. A session-header button opens `dsh-resource://trace/session/<sessionId>` as the `trace` tab kind. While recording is off the tab shows only a short note and a button that opens the Panedesk features page. The items page lists open and closed items, creates an item, shows the selected item's timeline, assigns checked unassigned activity, closes an item, and downloads the selected item as JSON or Markdown. Each activity row is one sentence; its stored type is the row tooltip. Unassigned activity scrolls, and the assign button names its target and stays disabled when nothing can be assigned. Turning item recording on or off shows its notice next to the switch. Activity summaries include reply or command previews and changed file names. A reference button shows wrapped, scrollable diff lines or message text without reasoning. The decisions page refreshes after committed decision writes, lists current entries with their window, model, and time, and offers reversion only for entries not already reverted. History labels rejected proposals as rejected. Pending proposals and their confirm and reject buttons appear only while strict mode is on; the planning-window menu has a bounded, scrollable list.

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
- Export starts a browser download and names the file without claiming completion. It does not write into the workspace. The desktop app opens a save dialog.
- Timeline pages use the service default page size. Current decisions and history share one live revision list.
- The panel does not offer voiding an item.

## Dev Note

`src/index.ts` is the empty host half. `src/client/index.ts` mounts `traceStore` and registers the settings row and the sidebar tab. Both faces call only that remote.
