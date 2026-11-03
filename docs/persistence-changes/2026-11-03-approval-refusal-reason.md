---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-03-approval-refusal-reason

English | [中文](2026-11-03-approval-refusal-reason.zh.md)

## Summary

Adds an optional concrete policy-refusal reason to the approval decision audit event.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-approval-refusal-reason
baseline: false
changes:
  - root: "event:approval/decided"
    previous: "2026-09-11-initial"
    after: "8e41e729609767fd1c3697ad5ab323068db7273ab48eabc49d5c55f03ec94c69"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing events without reason remain valid. Older readers retain the existing rejected outcome and may ignore the additional audit-only string; new readers accept its absence. The field does not authorize actions or alter replayed consent. No event discriminator or outcome value changes.

<a id="verification"></a>
## Verification

The targeted Windows owner-write, platform-default, state-trust locale, workspace-access UI, and local ACL-grant checks passed: 5 files, 31 tests. The nested-state case asserts rejected and the concrete bilingual reason. Other capture failures retain unavailable.

<a id="dev-note"></a>
## Dev Note

None.
