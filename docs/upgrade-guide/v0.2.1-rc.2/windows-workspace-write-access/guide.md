---
kind: upgrade-guide
description: Windows deployments without an explicit permission mode now start read-only instead of allowing workspace writes.
---

# Windows workspace write access

English | [中文](guide.zh.md)

## Change

Windows deployments that do not select a sandbox mode now use `read-only`. Linux and macOS retain `workspace-write`. An explicit `PANEDESK_PERMISSION_MODE`, sandbox-policy configuration, or session mode keeps its existing meaning. The base profiles no longer insert a writable fallback before policy resolution.

The General settings page manages directory-specific Windows workspace write access for the built-in local Windows sandbox. A saved authorization enables workspace writes only while the platform default applies. Existing workspace ACEs do not count as saved consent. First-write confirmation is not available; an unapproved workspace remains read-only.

## Migration

1. Leave the mode unset to use the Windows read-only default. Remove a previously configured `PANEDESK_PERMISSION_MODE=workspace-write` if that override is no longer intended. Existing explicit session modes also take precedence over directory authorization.
2. To permit a particular directory, open General settings and use **Windows workspace write access** to select and authorize it. Confirm that it appears in the list, then use a session without an explicit sandbox-mode override. Custom runners do not support this settings operation.
3. Review entries marked **Legacy authorization (no record)**. Discovery checks workspace roots from local session history and registered seat directories; it does not scan every disk. Stop active workspace processes before revoking an entry. Revocation removes the product sandbox's persistent write ACE and authorization record, but does not terminate running processes or invalidate open handles. Do not delete the record as a substitute for ACL revocation.
4. If revocation fails, retry it from settings. A persistent revocation marker blocks directory-based authorization until cleanup succeeds. Explicit deployment or session modes remain independent and must be removed separately when read-only operation is required.

See the [policy reference](../../../../packages/sandbox/sandbox-policy/README.md) and [permission settings reference](../../../../packages/client/ui-permission-presets/README.md) for the current behavior and limitations.
