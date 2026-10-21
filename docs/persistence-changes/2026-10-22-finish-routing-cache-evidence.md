---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-22-finish-routing-cache-evidence

English | [中文](2026-10-22-finish-routing-cache-evidence.zh.md)

## Summary

Adds optional non-sensitive account labels, actual cache write tier names, effective wire retention, and downgrade reasons to persisted finish chunks.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-finish-routing-cache-evidence
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-10-22-cache-response-evidence"
    after: "41f8c16d4681c4cd8b2f317262cc4c2d21ca65ab27514e7e8b75e4dc698316d2"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-10-22-cache-response-evidence"
    after: "9622e21efac0d87dfaebe3a771a35b3872823ad70f4df758f18da8c32832d2c7"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The Session version and chunk discriminants are unchanged. Existing records omit the new optional fields and remain valid; absence means unobserved, not a fabricated cache tier. Older readers preserve raw finish chunks as lossless JSON and assembly reads only known reason and replay fields, so the added evidence neither changes message content nor requires replay behavior. New readers accept records without this evidence. The effective retention excludes the request-only default value. Ledger sidecar declarations are independent of Session storage.

<a id="verification"></a>
## Verification

Reviewed adapter emission, runtime forwarding, AssistantStreamAttempt, AssistantStreamAccumulator snapshot/validation, BlockAssembler, and durable assistant event types. CI=true LANG=C.UTF-8 node_modules/.bin/vitest run over the changed packages and adjacent consumers passed: 130 files, 2801 tests. No adapter, assembler, or reader implementation changed; persistence history and catalog verification are run separately after recording.

<a id="dev-note"></a>
## Dev Note

None.
