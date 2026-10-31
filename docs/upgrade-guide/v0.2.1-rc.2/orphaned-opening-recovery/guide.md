---
kind: upgrade-guide
description: "Unclaimed orphaned seat openings close automatically after fenced owner death instead of waiting for manual closure."
---

# Orphaned opening recovery

English | [中文](guide.zh.md)

## Change

Seat-local recovery automatically withdraws an unclaimed first handoff and archives its window after confirmed owner death and fenced resource release. Previously this window waited for manual closure. The existing `opening-failed` cause `seat-local/opening-owner-lost` precedes `window-ended` with reason `owner-dead`; no end-reason value is added. Claimed or injected input and unknown ownership remain excluded.

Source-owner integrations may use authenticated failure and closure evidence plus released reservations to authorize one durable reassignment. A local close alone is not permission to replay an unknown delivery. Deploy executor and source-owner versions together when enabling this behavior.

## Migration

1. Stop new source admission and back up the complete executor and source-owner persistent domains before upgrading. Retain both versions and their recovery checkpoints.
2. Restore the source owner before starting the executor. Preserve callback routes, authentication accounts and original operation identities; do not clear pending callbacks or opening deliveries.
3. Confirm that an eligible orphan has one failure and one window-ended callback, its old delivery is withdrawn, and its reservation is released before any reassignment. Confirm that claimed input remains untouched and unknown outcomes use exact-key queries.
4. For rollback, stop admission and reconcile all callbacks and successor generations first. A source-owner domain containing automatic-resend audit fields cannot be read by older strict readers. Restore only a coordinated pre-upgrade backup after accounting for subsequent effects; never restore one side alone or erase a retry counter to resume work.
