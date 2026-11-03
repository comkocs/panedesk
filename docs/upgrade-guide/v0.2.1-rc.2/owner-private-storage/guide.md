---
kind: upgrade-guide
description: "Local credentials move into a private directory, launch links become single-use, and HTTP API connections require an owner cookie."
---

# Owner private storage and launch links

English | [中文](guide.zh.md)

## Change

The default credential document moves from `$PANEDESK_HOME/.credentials.yaml` to `$PANEDESK_HOME/private/.credentials.yaml`. Its complete parent directory is excluded from confined file and process access. A configured credential path remains unchanged, but its parent must be dedicated and disjoint from the workspace. Explicit full-access tools remain outside this read restriction.

Browser launch links expire after five minutes and can exchange for a browser cookie only once. `/connect` no longer accepts launch tokens; it requires an authenticated browser owner cookie and still returns a separate API Peer cookie. Existing signed browser cookies retain their configured lifetime. New browser sessions wait for owner confirmation on the POSIX Host controlling terminal; after confirmation, refresh the clean page. These sessions may require login again after a restart. Windows Web and services without an interactive terminal refuse new logins by default.

## Migration

Before upgrading a service-hosted Web instance, configure the `client-connection` row in an owner-protected file with `requireOwnerConfirmation: false` if interactive confirmation is unavailable. The owner accepts that anyone holding an unused launch link can then log in. Leave confirmation enabled for interactive POSIX use. Downgrading without explicitly configuring the new credential path makes the old release appear to have no saved credentials; it does not reverse the relocation.

1. Keep an owner-only backup of the existing credential document. For the default path, startup copies the old document into `private`, validates and synchronizes the successor, then removes the old document. Identical copies allow restart to resume; conflicting copies are preserved and startup stops. Reconcile them before retrying. Custom paths do not move automatically.
2. Put a custom credential file in a dedicated directory outside the workspace and other required readable roots. Do not create hard-link copies of owner material. Confined execution refuses material it cannot isolate; do not switch to full access merely to suppress that refusal.
3. Open a fresh CLI Web launch link once, within five minutes. Desktop receives a fresh cookie over its inherited IPC channel and keeps it in memory, without terminal confirmation. Do not publish launch links or copy cookies into model-visible logs or arguments. Restart the Host if a manually retained link has expired or was consumed.
4. HTTP API clients must obtain the browser owner cookie through an owner-controlled channel, then request `/connect?interactions=none` or `answer` with that cookie. Keep the returned API cookie separate from browser storage. The TypeScript and Python SDK running-Host credential-file flow is unchanged.
5. Confirm that owner login and credential resolution work, the default old document is absent, and sandboxed reads of the private directory fail. Before rolling back, configure the older release to use the relocated file explicitly; automatic downgrade relocation is not provided.
