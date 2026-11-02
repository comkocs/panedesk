---
kind: upgrade-guide
description: Windows deployments without an explicit permission mode now start read-only instead of allowing workspace writes.
---

# Windows workspace write access

English | [中文](guide.zh.md)

## Change

Windows defaults to `read-only`; Linux and macOS retain `workspace-write`. Explicit environment, sandbox-policy, and session modes are unchanged. Base profiles have no writable fallback.

General settings manages built-in Windows sandbox directory writes. Consent enables writes only under platform defaults; existing ACEs are not consent. First-write approval saves consent and materializes ACLs. Rejection, cancellation, missing answerers, and expiry preserve read-only access. Unattended headless uses `never`, including resumes. Owner streams authenticated and answering at setup preserve policy; later connections do not. Windows native execution remains unvalidated.

Dynamic Cordis packages cannot activate under the implicit Windows default, including browser-panel starts and previously approved versions. Their same-process Host and same-origin Client code can access owner approval capabilities. Directory write consent does not enable dynamic code; inspection and definition storage remain available.

Confined writes exclude host profiles, configuration, plugin inputs, and hot-reload roots, including active watches and missing symlink-prefixed inputs. Authorization permits nested protected inputs, not mutation; wholly protected workspaces remain rejected. [Provider limitations](../../../../packages/sandbox/sandbox-local/README.md#known-limitations-and-deferred-work) govern sibling writes and Windows replacement validation. Unrelated development clones remain writable. Overlapping temporary-root grants are omitted; use workspace output. Tightening permissions affects new calls, not existing processes or handles; close and reopen persistent model terminals that reject input afterward. The permission-mode selector does not immediately reflect directory records. `danger-full-access` grants the host user's full write authority, including configuration and plugins; each `plugin_manager` change still requires owner approval.

Host-fallback inputs require owner-approved coverage before commands start. Diagnostics list fallback separately; native backend limitations remain.

## Migration

1. Leave the mode unset to use the Windows read-only default. Remove a previously configured `PANEDESK_PERMISSION_MODE=workspace-write` if that override is no longer intended. Existing explicit session modes also take precedence over directory authorization.
2. In General settings, authorize the directory through **Windows workspace write access**. Confirm its listing, then use a session without an explicit mode override. Custom runners do not support this operation.
3. Review **Legacy authorization (no record)** entries discovered from local sessions and registered seat directories, not disk-wide scans. Stop workspace processes before revocation: it removes persistent sandbox ACEs and records, not processes or open handles. Deleting records does not revoke ACLs.
4. If revocation fails, retry it from settings. A persistent revocation marker blocks directory-based authorization until cleanup succeeds. Explicit deployment or session modes remain independent and must be removed separately when read-only operation is required.
5. Keep the implicit default to disable dynamic Cordis activation. Every `plugin_manager` change requires authenticated owner approval, even with explicit deployment modes or `danger-full-access`; inventory-read checks remain. After returning from dynamic-code deployments, restarting the Host and reloading pages is recommended, not required for first-write confirmation.

6. Inspect coverage with `panedesk --profile headless --sandbox-status en --json`. Restore missing owner-approved coverage; never delete trusted records or bypass confinement. See [diagnostics](../../../../packages/bundle/headless/README.md).

See [policy](../../../../packages/sandbox/sandbox-policy/README.md) and [permission settings](../../../../packages/client/ui-permission-presets/README.md).
