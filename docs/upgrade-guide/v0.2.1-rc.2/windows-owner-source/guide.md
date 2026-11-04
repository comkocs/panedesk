---
kind: upgrade-guide
description: "Windows owner admission identifies product sandbox processes by host-owned Job membership."
---

# Windows owner connection sources

English | [中文](guide.zh.md)

## Change

Windows TCP connections originating in a registered product sandbox cannot act as owner even with a valid cookie. The host queries IPv4 and IPv6 connection-owner tables and checks the owning process against its product Jobs. Missing rows, inaccessible processes, failed membership queries, and transports without TCP facts are unknown and refuse owner admission with an English/Chinese reason. Browser integrity levels, AppContainer status, and restricted-token flags are not product identity. Edge, Chrome, and Firefox outside the product Jobs remain eligible. Decisions are cached per physical connection, including keep-alive requests and upgrades.

## Migration

Upgrade the local sandbox, local subprocess, and Win32 process packages together, then restart the host and existing sandbox processes. Custom consumers must preserve `productSandbox: true` through ordinary and terminal spawn requests. The provider registers its Windows lookup before permitting product execution; the trusted ACL runner joins its host-created Job before creating any restricted child. Ordinary commands do not enter product Jobs. A removed provider refuses new owner connections rather than reverting to permission. Cookie persistence and new-browser confirmation settings are unchanged.

The host retains separate Job identities across provider reloads, closes them on exit, and refuses further sandbox launches at its retention limit; restart the host to reclaim the identities. Existing per-command kill-on-close Jobs remain independently owned. Windows 8 / Server 2012 or later and a valid nested Job hierarchy without UI limits are required; incompatible external Job restrictions cause startup failure, not unrestricted execution. See [provider lifecycle](../../../../packages/subprocess/subprocess-local/README.md) and Microsoft's [nested Job restrictions](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs).

Windows behavior has substitute tests only; native Windows acceptance is outstanding. The lookup rechecks ownership while holding a process handle, but process-ID reuse and connection replacement races have no native validation. Product Jobs use the host token's default object security; another same-user process may hold an additional handle, so host closure alone does not establish last-handle termination. Failed launches also consume the retained-identity limit. Standalone ACL library calls or custom providers that omit host identity registration are not covered. Scheduled tasks, WMI, COM, and ShellExecute may delegate creation to processes outside the Job hierarchy; those paths remain unverified hardening work required before the M9 stable release. Trusted host plugins and MCP servers remain outside this protection. No breakaway flags, UI restrictions, console settings, or ConPTY parameters are changed.
