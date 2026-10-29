---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-29-subagent-report-paths

English | [中文](2026-10-29-subagent-report-paths.zh.md)

## Summary

Adds optional reportPaths to subagent completion-message sources in user, developer, inbox and title-request events.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-29-subagent-report-paths
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-22-message-delivery"
    after: "50d8870c243f856efea4c7376cae8261e2474dae1032f7ef0f4855f25cab3d98"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-22-message-delivery"
    after: "5367bb1b70853870821aafbec035fa339a41fdecae3523a0362a0c1418a1a262"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-22-message-delivery"
    after: "8e4e1300eaff1472e3e9c158718893bfdc9d85daa54fa6d32290611bd2aa515c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-22-message-delivery"
    after: "55ed93dabc12a312ce531d0492f740381b426084c91d6c3e85e40e8a2d835678"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The existing subagent-settled discriminator and all required fields remain unchanged. Older records omit reportPaths and remain readable. Readers use the new optional field only for presentation; missing paths preserve existing behavior, and paths are untrusted hints rather than instructions or verified files. The field does not change execution, replay ordering or protocol operation numbers.

<a id="verification"></a>
## Verification

The Loader composition in packages/seat/seat-gates/tests/completion-wake-composition.spec.ts passed all four command/subagent and idle/busy cases, including a single persisted completion notice, path hints, and no duplicate delivery after the retry window. Host tsc --noEmit exited 0. Persistence preview classified all four affected roots as optional-property-added without a required compatibility review.

<a id="dev-note"></a>
## Dev Note

None.
