---
kind: upgrade-guide
description: Windows deployments without an explicit permission mode now start read-only instead of allowing workspace writes.
---

# Windows workspace write access

English | [中文](guide.zh.md)

## Change

Windows defaults to `read-only`; Linux and macOS retain `workspace-write`. Explicit environment, sandbox-policy, and session modes are unchanged. Base profiles have no writable fallback.

General settings manages built-in Windows sandbox directory writes. Consent enables writes only under platform defaults; existing ACEs are not consent. First-write approval saves consent and materializes ACLs. Rejection, cancellation, missing answerers, and expiry preserve read-only access. New and resumed headless sessions use `never`: no prompts, even with an owner connected. Windows native execution has not been validated on a Windows machine.

Dynamic Cordis packages cannot activate under the implicit Windows default, including browser-panel starts and previously approved versions. Their same-process Host and same-origin Client code can access owner approval capabilities. Directory write consent does not enable dynamic code; inspection and definition storage remain available.

Confined writes exclude host profiles, configuration, plugin inputs, and hot-reload roots, including active watches and missing symlink-prefixed inputs. Workspace authorization cannot include protected inputs. Unrelated development clones remain writable. Overlapping temporary-root grants are omitted; use workspace output. Tightening permissions affects new calls, not existing processes or handles; close and reopen persistent model terminals that reject input afterward. The permission-mode selector does not immediately reflect directory records. `danger-full-access` grants the host user's full write authority, including configuration and plugins; each `plugin_manager` change still requires owner approval.

## Migration

1. Leave the mode unset to use the Windows read-only default. Remove a previously configured `PANEDESK_PERMISSION_MODE=workspace-write` if that override is no longer intended. Existing explicit session modes also take precedence over directory authorization.
2. In General settings, authorize the directory through **Windows workspace write access**. Confirm its listing, then use a session without an explicit mode override. Custom runners do not support this operation.
3. Review entries marked **Legacy authorization (no record)**. Discovery checks workspace roots from local session history and registered seat directories; it does not scan every disk. Stop active workspace processes before revoking an entry. Revocation removes the product sandbox's persistent write ACE and authorization record, but does not terminate running processes or invalidate open handles. Do not delete the record as a substitute for ACL revocation.
4. If revocation fails, retry it from settings. A persistent revocation marker blocks directory-based authorization until cleanup succeeds. Explicit deployment or session modes remain independent and must be removed separately when read-only operation is required.
5. Keep the implicit default to disable dynamic Cordis activation. An explicit deployment mode is not permission for the model to install plugins: every `plugin_manager` change now asks the authenticated owner, even in `danger-full-access`. Inventory reads retain their previous permission checks. When returning from a deployment that ran dynamic code to the implicit default, restarting the Host and reloading connected pages is recommended housekeeping, not a prerequisite for first-write confirmation.

See [policy](../../../../packages/sandbox/sandbox-policy/README.md) and [permission settings](../../../../packages/client/ui-permission-presets/README.md).
