---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-02-protected-input-approval

English | [中文](2026-11-02-protected-input-approval.zh.md)

## Summary

Adds protected-input as an explicit owner approval purpose carrying a path and previous and candidate digests.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-02-protected-input-approval
baseline: false
changes:
  - root: "event:approval/asked"
    previous: "2026-11-02-workspace-write-approval"
    after: "bed5a8f779840c79899e36b28ce0246f886bc17d8f37353695fe594b6082eb4d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing workspace-write records retain their discriminator and fields. The new purpose is distinguished by type: protected-input; it does not reuse the workspace field or imply a write grant. Approval audit records are log-only and are not replayed as authorizations. Runtime owner decisions use the authenticated event stream, and only allowed-once authorizes the consumer's exact candidate. The between-turn host workflow retains passive inbox messages instead of emitting turn-enclosed approval audit events. No Session format constant changes.

<a id="verification"></a>
## Verification

Focused protected-input approval, profile HMR, integrity, and browser approval suites passed 54 tests. Owner allow and refusal, unattended passive inbox retention, different owner connection refusal, SDK automation interaction refusal, and approval-time candidate replacement were exercised. The broader boot suite still has 95 failures; this acknowledgement does not assert complete host input protection.

<a id="dev-note"></a>
## Dev Note

None.
