---
description: "Right-sidebar verification checklist grouped by requirement, with observed activity time."
kind: "package-reference"
---

# @panedesk/dsh-client-ui-verification-checklist

English | [中文](README.zh.md)

## Summary

Open a session's verification checklist from its header into a right-sidebar tab. Requirements are grouped by the title the agent submitted. Each check shows its note, estimated minutes, and the actual category time observed for that session. Categories the workspace has turned off are greyed with a note, and turning a check off appends that category to the current task's prohibitions. Categories that ran without being declared are marked undeclared and their time still counts. Checklists submitted by a child session roll up into the parent's panel.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The header pill opens `dsh-resource://verificationchecklist/session/<sessionId>` as the `verificationchecklist` tab kind. It is absent for the `minimal` preset. Actual time comes from the subagent tree resource for the same session. Grey-out reads the workspace verification record; when none is available the product default applies and only mutation tests are greyed. A check whose session has no current activity task cannot be turned off. Failed policy reads and prohibition writes show the original service error.

-----

<a id="model-experience"></a>
## Model Experience

### Verification checklist panel

#### What the model sees

Nothing. The panel is a user-facing view of checklists the agent already submitted.

#### Token effect

None.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Turning a check off is one way** — the prohibition is appended and cannot be removed from this panel.
- **Activity time needs the tree resource** — a session whose tree has not loaded shows its checks with unknown actual time.
- **Child roll-up uses the parent's tree** — a child whose activity the parent's tree does not report shows unknown time in the parent panel; its own monitoring details still show it.

<a id="dev-note"></a>
## Dev Note

The host entry exports an empty `apply`; the browser half lives at `./client`. Feature packages are not imported at runtime: the checklist and verification resource types arrive through type-only imports.
