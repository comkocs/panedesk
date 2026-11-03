---
kind: upgrade-guide
description: Windows defaults to read-only without explicit permission modes.
---

# Windows workspace write access

English | [中文](guide.zh.md)

## Change

Windows defaults to `read-only`; Linux/macOS retain `workspace-write`. Explicit environment/sandbox-policy/session modes remain. Base profiles have no writable fallback.

Directory consent applies only under platform defaults; ACEs alone are not consent. Approval saves consent and materializes workspace ACLs while preserving protected inputs. Rejection, cancellation, expiry or absent answerers leave access read-only. Unattended headless uses `never`, including resumes; only authenticated owner streams answering at setup preserve approval policy, not later connections.

Implicit Windows defaults prohibit dynamic Cordis activation, including previously approved packages and browser-panel starts: their Host/Client code can reach approval capabilities. Directory consent does not enable them; inspection and definition storage remain available.

Confined writes exclude profiles, configuration, plugins and hot-reload inputs, including watches and missing symlink-prefixed paths. Wholly protected workspaces remain rejected; unrelated clones remain writable. Overlapping temporary grants are omitted: use workspace output. [Provider limitations](../../../../packages/sandbox/sandbox-local/README.md#known-limitations-and-deferred-work) govern sibling writes and replacement validation. Host-fallback inputs require owner-approved coverage. Owner-installed MCP/providers are not constrained by this sandbox.

`danger-full-access` retains host-user writes, including configuration/plugins; every `plugin_manager` change still requires authenticated owner approval and inventory checks. The mode selector does not immediately reflect directory records. Tightening permissions affects new calls, not existing processes/handles; reopen persistent terminals that reject input.

State storage rejects all writes, deletion, `WRITE_DAC`, and `WRITE_OWNER`. Ancestors reject deletion and ownership/DACL changes, including parent delete-child access; only the nearest existing parent of a missing name also rejects creation. Non-inheriting writes higher in the ancestry do not invalidate existing storage. Unsafe records cannot authorize writes or supply workspace configuration. Read-only reads omit that configuration; the runner checks its actual workspace/temp token before spawning. [Native limitations](../../../../packages/sandbox/sandbox-windows-acl/README.md#use-this-package) apply. Windows native execution remains unvalidated.

## Migration

1. Remove unintended `PANEDESK_PERMISSION_MODE=workspace-write` and explicit session overrides. Authorize directories in General settings under **Windows workspace write access**; custom runners are unsupported.
2. Review entries marked **This workspace has write access left by an older version** from sessions/registered seats, not disk-wide discovery. Unrecorded effective root writes also trigger this notice on opening. Stop workspace processes before revoking. Cross-restart revocation scans all explicit exact-workspace-SID entries, including `node_modules`; links do not lead outside the tree. Root/every hit undergo AccessCheck, including parent delete-child. Errors or residual writes retain the revocation marker; retry settings cleanup. Explicit modes remain independent. Deleting records alone never revokes ACLs.
3. Keep implicit defaults to disable dynamic activation. After dynamic-code deployments, restarting Host/reloading pages is recommended, not required for first-write confirmation.
4. Inspect coverage: `panedesk --profile headless --sandbox-status en --json`. Restore approval coverage; never delete trusted records or bypass confinement. See [diagnostics](../../../../packages/bundle/headless/README.md).
5. On state refusal, back up/review the reported directory, SID and ACE. Example: `icacls.exe 'C:\state-ancestor' /remove:g '*S-1-4-123-456'`. Substitute exact diagnostic values: this removes all explicit allows for that trustee. Correct inherited grants at their source; incomplete diagnostics require manual review, never guessed removal.

Known legacy roots use revocation. State ancestors receive manual guidance only. Unknown old paths/SIDs require the [exact-SID procedure](../../../../README.md), never prefix-based recognition.
