---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-08-after-tools-input

English | [中文](2026-11-08-after-tools-input.zh.md)

## Summary

Adds optional afterTools scheduling metadata to pending Agent input, allowing queued prompts to join the request after a completed tool step while final answers retain next-turn delivery.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-after-tools-input
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-29-subagent-report-paths"
    after: "8d28dd42eb03b986f5326f2544eb9f9e443868554b53004fa29e1c49dadba340"
    decision: same-version
  - root: "event:agent/input/transition"
    previous: "2026-10-22-message-delivery"
    after: "74ec79de4358fd720eefa4dd9d41d619a7ea0066e0507862e5651e46b3a970b9"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers accept older records because afterTools is optional and absence preserves next-turn queue scheduling. Older readers ignore the extra scheduling property and continue to hold priority queue messages until the next turn. They may delay delivery, but do not cancel active tools, omit model-visible input, or reinterpret queued content. The existing priority, passive, wakeup, identity and earliest-turn fields remain unchanged. No Session format or operation number changes.

<a id="verification"></a>
## Verification

Manually inspected Inbox scheduling serialization, projection validation, claim selection and AgentLoop request/tool completion paths. No tests, lint or CI were run under this assignment; package compilation evidence is recorded separately in the delivery report.

<a id="dev-note"></a>
## Dev Note

None.
