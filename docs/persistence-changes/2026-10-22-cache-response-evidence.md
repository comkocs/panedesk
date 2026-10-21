---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-22-cache-response-evidence

English | [中文](2026-10-22-cache-response-evidence.zh.md)

## Summary

Adds optional cache retention controls, long-tier cache-write counts, and provider response evidence to existing request and assistant-stream payloads.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-cache-response-evidence
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "eb608af79b9fa565a1df6485962ee1c9c439a3dd0a0f9107f5bcdbdd0c66cc63"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "ec644f73d256557dd3c575126bd0d7c758236a3d9ce097b9225eada82b87f129"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "0be441e0594eb8c4d2980c607fbb02b07d32e28750ead053140b80e0e6c2ab90"
    decision: same-version
  - root: "event:request/header"
    previous: "2026-09-16-session-format-v4"
    after: "03a30239b47b11cd23e5e4dc32280a5bc17e8e7923f7f90a3b178d7e72060503"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid because every added persisted member is optional. The Session header version and event discriminators are unchanged. The released reader validates request provider/model and adapter-default markers without rejecting additional config members; assistant settlements validate stream arrays without interpreting optional finish metadata. Compact stream accumulation preserves complete usage and finish chunks. Older readers may ignore the new accounting evidence and cache controls, so they do not provide the new accounting or cache-policy behavior. Missing evidence must remain unknown rather than implying a cache hit, a reported model, or a zero charge. New readers continue to accept records without these members.

<a id="verification"></a>
## Verification

Source review: packages/core/session/src/index.ts assertCurrentLlmShape and assertAssistantSettlementShape; packages/core/session/src/surface.ts validateSessionEventData; packages/session/session-format-v3-to-v4/src/validation.ts restoreReleasedV4Artifact; packages/llm/llm/src/assistant-stream.ts AssistantStreamAccumulator.push. Focused tests and repository gates are pending; this acknowledgement does not claim they passed.

<a id="dev-note"></a>
## Dev Note

None.
