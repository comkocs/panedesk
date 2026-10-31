---
description: "Right-sidebar session tab opened from a session row, plus a per-message pin kept in the browser that never changes what the model sees."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-session-tab

English | [中文](README.zh.md)

## Summary

This package adds a session page type to the right sidebar and a pin on each finalized assistant message. The page is opened from a session row's menu and renders that session's transcript and composer alongside its pin list; choosing a pin scrolls only that sidebar transcript occurrence. A pin is a bookmark kept in the browser. It survives a restart and never changes what a model sees. The session-row entry reserves two sidebar session tabs beside the main area.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside `ui-workspace`, `ui-sidebar-right`, and `ui-conversation`. A session row's menu gains "Open in the right sidebar". The page type is not on the guide, so it does not appear before a session starts. The pin sits in the action row of a finalized assistant message. The session page lists that session's pins and jumps to one that is on screen.

### Failures

Opening a third right-sidebar session is refused while the main area and two panes are already full, and the menu says so. A browser that cannot keep storage shows that the pins cannot be saved. A pin whose message is not loaded asks the user to load the matching history first.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package registers the `session` tab type with `multiple: true` and no guide entry, contributes `open-in-right` (order 500) to `sidebar.workspaces.session.menu.item`, and contributes `pin` (order 20) to `conversation.chat.assistant-actions`. Pins are one document under `dsh.session-pins.v1`: `{ schemaVersion: 1, pins: [{ sessionId, messageId, pinnedAt }] }`. A `sessiontab` resource retains the target through `sessions.retain`, awaits opening, supplies its `SessionProvider`, and releases it when the resource closes. The shared `conversation.content` factory renders the transcript and composer. The jump searches only this page for `data-message-id`. Pin writes publish through a framework-bound observable after storage succeeds; unsupported document versions are not overwritten. The entry counts open session and subagent tabs in the mounted layout and refuses a third sidebar session tab. It prefers a new docked pane when space permits.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-sidebar-right](../ui-sidebar-right/README.md) — the tab registry and the two-pane budget.
- [ui-workspace](../ui-workspace/README.md) — the session row menu.
- [ui-conversation](../ui-conversation/README.md) — the assistant action row.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as session tabs and browser-local bookmarks add no model-visible content or session events.

#### KV Cache effect

None. Opening a session tab and storing or removing a pin leave the model-visible history unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current session tab. They are current package constraints, not a backlog.

- **A pin jumps only to a rendered action row** — the completed-turn action row carries `data-message-id`. A pin whose row is not rendered says so instead of scrolling.
- **Session limit is entry-local** — hidden session tabs count toward the entry budget. Floating panels and later docking actions are not subject to a global visible-session limit.
- **Pins stay in this browser** — the document is local storage. Another browser, or storage that was cleared, does not have them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
