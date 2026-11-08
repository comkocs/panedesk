---
kind: upgrade-guide
description: The saved steer composer preference now queues input after tools instead of extending a final answer.
---

# Running composer delivery

English | [中文](guide.zh.md)

## Change

The `ui-conversation` busy-Enter preference keeps its `steer` and `queue` values. `steer`, the default, now waits for every tool in the current step before joining the next owed request. A final answer closes its turn before queued input starts another turn. `queue` still waits for the whole turn. Pending messages appear as FIFO bubbles below the active answer, rather than a collapsed composer dock.

## Migration

1. Keep existing settings; no data migration is required. Select “After this turn” to retain turn-boundary delivery.
2. Use a pending bubble's “Send now” action for legacy Steer behavior. The × action withdraws its text into the end of the current draft after Host acceptance.
3. In the settings UI, confirm that the existing `steer` choice is labeled “Next step (default, no interruption)”. The [persistence acknowledgement](../../../persistence-changes/2026-11-08-after-tools-input.md) documents the optional scheduling field; Session format versions are unchanged.
