---
description: "Right-sidebar project items and decisions, plus workspace recording switches."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-trace

English | [中文](README.zh.md)

## Summary

The Panedesk features page carries the workspace switches for project recording. A right-sidebar tab lists that workspace's items, their activity, unassigned activity, and decisions. Recording stays off until the user turns it on. The tab reads and writes only through the `traceStore` remote; it keeps no record of its own.

## Use this package

The settings row offers item recording, a link to an existing project, and strict mode. Strict mode can be changed only while recording is on, and it names one planning window from the workspace's own sessions. A session-header button opens `dsh-resource://trace/session/<sessionId>` as the `trace` tab kind. While recording is off the tab shows only a short note and a button that opens the Panedesk features page. The items page lists open and closed items, creates an item, shows the selected item's timeline, assigns checked unassigned activity, closes an item, and downloads the selected item as JSON or Markdown. A reference button reads the stored text or diff. The decisions page lists current entries with the window, model, and time that recorded each one, and can revert one entry. Pending proposals and their confirm and reject buttons appear only while strict mode is on.

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
- Export downloads a file in the browser. It does not write into the workspace.
- Timeline pages use the service default page size, and decision history is read per current decision.
- The panel does not offer voiding an item.

## Dev Note

`src/index.ts` is the empty host half. `src/client/index.ts` mounts `traceStore` and registers the settings row and the sidebar tab. Both faces call only that remote.
