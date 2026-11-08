---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-08-approval-asked-purpose

English | [中文](2026-11-08-approval-asked-purpose.zh.md)

## Summary

The approval/asked purpose field now uses the current purpose object. Host-input capture is no longer part of this event.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-approval-asked-purpose
baseline: false
changes:
  - root: "event:approval/asked"
    previous: "2026-11-02-protected-input-approval"
    after: "3cd6c45914d5c48606d1c426ff75610cc4d023aa0d430b0b0384dfa44e661381"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing sessions keep their recorded approval events. Readers accept the current purpose object without rewriting stored sessions.

<a id="verification"></a>
## Verification

pnpm exec tsx scripts/persistence-changes.ts --check reports no unacknowledged persistence type changes after this record.

<a id="dev-note"></a>
## Dev Note

None.
