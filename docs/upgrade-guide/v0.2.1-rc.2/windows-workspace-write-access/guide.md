---
kind: upgrade-guide
description: Windows deployments without an explicit permission mode now start read-only instead of allowing workspace writes.
---

# Windows workspace write access

English | [中文](guide.zh.md)

## Change

Windows defaults to `read-only`; Linux and macOS retain `workspace-write`. Explicit environment, sandbox-policy, or session modes retain their meaning. Base profiles supply no writable fallback.

The General settings page manages directory-specific Windows workspace write access for the built-in local Windows sandbox. A saved authorization enables workspace writes only while the platform default applies. Existing workspace ACEs do not count as saved consent. The first potentially writing tool call can request dedicated workspace consent; acceptance saves the directory authorization and materializes its ACL. Rejection, cancellation, missing answerers, and expiry keep the workspace read-only. Unattended `never` sessions do not prompt.

Dynamic Cordis packages cannot activate under the implicit Windows default, including browser-panel starts and previously approved versions. Their same-process Host and same-origin Client code can access owner approval capabilities. Directory write consent does not enable dynamic code; inspection and definition storage remain available.

Confined writes exclude the running host's profile, configuration, plugin inputs, and hot-reload roots. Workspace authorization cannot include these paths; unrelated plugin development projects and source clones remain writable. Protection includes active configuration watches and missing symlink-prefixed inputs. Tightening permissions does not terminate existing processes or handles; new calls immediately use the new policy. `danger-full-access` explicitly grants the host user's full write authority, including configuration and plugins; `plugin_manager` still requires owner approval for each change.

## Migration

1. Leave the mode unset to use the Windows read-only default. Remove a previously configured `PANEDESK_PERMISSION_MODE=workspace-write` if that override is no longer intended. Existing explicit session modes also take precedence over directory authorization.
2. In General settings, authorize the directory through **Windows workspace write access**. Confirm its listing, then use a session without an explicit mode override. Custom runners do not support this operation.
3. Review entries marked **Legacy authorization (no record)**. Discovery checks workspace roots from local session history and registered seat directories; it does not scan every disk. Stop active workspace processes before revoking an entry. Revocation removes the product sandbox's persistent write ACE and authorization record, but does not terminate running processes or invalidate open handles. Do not delete the record as a substitute for ACL revocation.
4. If revocation fails, retry it from settings. A persistent revocation marker blocks directory-based authorization until cleanup succeeds. Explicit deployment or session modes remain independent and must be removed separately when read-only operation is required.
5. Keep the implicit default to disable dynamic Cordis activation. An explicit deployment mode is not permission for the model to install plugins: every `plugin_manager` change now asks the authenticated owner, even in `danger-full-access`. Inventory reads retain their previous permission checks. When returning from a deployment that ran dynamic code to the implicit default, restarting the Host and reloading connected pages is recommended housekeeping, not a prerequisite for first-write confirmation.

See the [policy reference](../../../../packages/sandbox/sandbox-policy/README.md) and [permission settings reference](../../../../packages/client/ui-permission-presets/README.md) for the current behavior and limitations.
