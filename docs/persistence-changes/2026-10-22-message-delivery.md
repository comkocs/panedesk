---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-22-message-delivery

English | [中文](2026-10-22-message-delivery.zh.md)

## Summary

Adds required input scheduling transitions and message receive settings, optional inbox scheduling and interruption/cancellation detail, and producer-owned message-delivery attribution. The independent message ledger is outside the Session event namespace.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-message-delivery
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "fa22b0edcaf841e7f760f3b22d1f416c6eaf191911f63aae30a1874ed48eabf8"
    decision: same-version
  - root: "event:agent/input/transition"
    previous: null
    after: "b9e10f1ac80ba67a20ba4c147c2c244eddec9d3cbe10152c65b8897bccdfbadf"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-10-22-finish-routing-cache-evidence"
    after: "679003a1efb09972bc012da3182fca051594d2023cb94f61d93d32c703016c02"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "52ae4bb312f6b70af07b559debb4cc99085c0497210cb1442aacbb0be39d6d60"
    decision: same-version
  - root: "event:message/settings"
    previous: null
    after: "757193c76cc6d99e1fd4bdf164ad5e6a62d2a6e688717d2213948605ab93ce51"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "56ae645fa4efcca3d3898f568363319208b90dc364c7fa2aa5bbf0b6bb4bd9a3"
    decision: same-version
  - root: "event:tool/result"
    previous: "2026-09-16-session-format-v4"
    after: "a754e11f97735cab7d4e48291f22fdfda0ae5c0bdbc9c36dbf2653aa225be3e4"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "97eefbc3e975784b2afcfc9c964b6af3ac6125ab91553758072a553e847c7e42"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "a04c293cd5c2c85c99cad9ef1592454ccef82ef314d124cfa731c6f3e6d7b83b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Same Session format version 4. New readers retain legacy inbox behavior when scheduling is absent and retain coarse interrupted/aborted semantics when optional details are absent. Writers must commit a required agent/input/transition with phase scheduled before the matching scheduling-aware inbox splice. Old readers refuse that unknown required event before replay or append, rather than silently scheduling passive input. message/settings is also required on read. Neither event is ignorable. Current V4 attribution admission preserves arbitrary nonempty producer-owned source kinds; message-delivery does not change message content or surface operations. interjection refines the existing aborted outer discriminator; coarse readers retain aborted semantics and the original reason object. Optional assistant interruptionReason and tool cancellation metadata do not replace retained content or claim side-effect rollback. No event writer, scheduling implementation, or Core format constant is changed by these declarations.

<a id="verification"></a>
## Verification

Ran LANG=C.UTF-8 CI=true vitest over 17 changed and adjacent package directories: 4060 passed, 14 skipped, with two unrelated environment failures. After building native system artifacts and removing the inherited Windows current-directory-search policy variable for the test process, the two affected package directories passed 430 tests with 13 skipped. The passing set includes storage-contract unknown-required refusal before adoption, current-event-admission refusal without truncating a provider append, and V4 codec/source admission. CI=true pnpm run typecheck exited 0 before the final type-only instruction observation export was connected. Source review verified storage-contract.ts required-event admission, JSONL format.ts pre-recovery admission, and V4 message-sources.ts preservation of producer source kinds. Scheduling and delivery writers remain unimplemented; these checks do not claim runtime message delivery or platform acceptance.

<a id="dev-note"></a>
## Dev Note

None.
