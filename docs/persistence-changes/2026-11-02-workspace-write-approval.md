---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-02-workspace-write-approval

English | [中文](2026-11-02-workspace-write-approval.zh.md)

## Summary

Adds an optional workspace-write purpose to approval/asked audit events, naming the canonical directory whose persistent authorization is requested.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-02-workspace-write-approval
baseline: false
changes:
  - root: "event:approval/asked"
    previous: "2026-09-11-initial"
    after: "3cd6c45914d5c48606d1c426ff75610cc4d023aa0d430b0b0384dfa44e661381"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Old audit events omit purpose and retain one-operation meaning. Older readers recognize approval/asked and preserve its JSON payload without interpreting purpose; this log-only audit event is neither replayed as an authorization nor used to grant access. The sandbox policy reads separate workspace authorization records, and acceptance does not append a sandbox/mode override. No Session format version changes.

<a id="verification"></a>
## Verification

The workspace-confirmation and ui-approval suites passed 49 tests. Coverage includes the persisted purpose, no sandbox/mode override, Loader allow/reject composition, record and ACL effects, revocation, cancellation, deadline, and a disconnected real Gateway/Remotes owner stream. The existing validateStoredEvents reader retains known-event JSON fields; authorization resolution reads WorkspaceWriteAccess rather than approval audit events.

<a id="dev-note"></a>
## Dev Note

None.
