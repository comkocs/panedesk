---
kind: upgrade-guide
description: Seat approval cancellation adds persisted close details that older strict engine and callback readers reject.
---

# Seat approval close details

English | [中文](guide.zh.md)

## Change

Closing an approval-paused seat window now cancels the pending turn through the Session controller, preserves queued input, and closes only after idle evidence and authorization are rechecked. The end reason remains `manual`; engine close records and `window-ended` callbacks may contain `detail: 'approval-pending-cancelled'`. Older records without this field remain readable, but older strict readers reject new records containing it. Session log format and the window-end reason enumeration are unchanged.

## Migration

1. Stop seat admission and drain active close and callback operations before upgrading the engine and every callback consumer together.
2. Back up the engine journal and each callback consumer's persistent domain while stopped. Keep these backups paired with the old application version.
3. Update strict callback readers to accept the optional detail without inventing a value for old records. Preserve it in downstream window-end reporting.
4. Restart the upgraded providers, close a tool-approval-paused window, and confirm the turn is cancelled and the durable end record retains `manual` plus the detail. Queued input or other busy evidence must still prevent closure.
5. Do not downgrade against domains containing the new field. A rollback requires restoring both pre-upgrade domains and the matching application version, with admission stopped; never delete the detail from individual records.
