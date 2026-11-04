---
kind: upgrade-guide
description: "Linux product-sandbox connections can no longer use owner cookies when native socket attribution and user cgroup delegation are available."
---

# Linux owner connection sources

English | [中文](guide.zh.md)

## Change

Previously, a valid owner cookie could authorize a connection originating inside a product sandbox. Linux owner admission now identifies registered product cgroups through the client's socket and refuses both product and unverifiable sources before launch-token exchange, API Peer creation, or authenticated dispatch. This applies to HTTP, HTTPS, and WebSocket upgrades. Ordinary host processes and browsers remain non-product sources. It does not govern a trusted host plugin making requests on another process's behalf or the separate host-admin credential protocol.

Linux requires cgroup v2 user-session delegation and native socket attribution; Linux 7.0 is verified, but the minimum kernel version is unknown. Without either, the host warns bilingually, returns non-product and cannot prevent cookie replay. An unavailable delegated launch scope also warns without refusing the command. macOS retains its warning; Windows uses the [Job-based classifier](../windows-owner-source/guide.md). See the [retention policy](../../../../packages/subprocess/subprocess-local/README.md#linux-sandbox-connection-identity). Cookie persistence, single-use tokens and new-browser confirmation are unchanged.

On Linux, a filter hit classifies an unrelated owner connection as unknown and refuses admission, without refusing new sandbox starts or permitting historical product identities. At 100,000, 1 million, and 2 million inserted retired identities, the estimated false-positive rates are 0.00047%, 2.07%, and 14.3%, respectively. A stable browser cgroup identity makes false positives persist until host restart. Close all sandbox sockets before restarting the host to clear the filter.

The opt-in experimental Python runtime now requires a subprocess provider and forwards confinement facts to it. The local Linux provider registers its confined processes under the same prerequisites; released profiles still do not enable this runtime. Its fd-3 protocol and TMPDIR-only model environment are unchanged. SSH confinement preserves the product marker through remote ordinary and terminal execution; upgrade the client and helper together. Its registration is remote and does not identify connections to the calling Host's gateway or protect an independently running remote Host. See [remote ownership and limitations](../../../../packages/ssh/ssh/README.md#understand-the-implementation).

## Migration

1. Upgrade the native entry and matching platform package together; custom Linux packages must rebuild `system.node`. An older addon without socket attribution results in the documented limitation, not an enforcement claim.
2. Ask the host administrator to provide a delegated cgroup v2 user session. Panedesk does not change system units or kernel configuration. If delegation is unavailable, run untrusted processes under a separate account and treat the startup warning as a security limitation.
3. Custom execution providers must preserve `productSandbox: true` from Linux confinement through `SubprocessSpawnSpec` or `SubprocessTerminalSpawnSpec`. Do not derive it from argv or a scope name. See the [provider prerequisites and lifecycle](../../../../packages/subprocess/subprocess-local/README.md#linux-sandbox-connection-identity).
4. Confirm that an ordinary browser still authenticates, while a product-sandbox request with an otherwise valid owner cookie receives a bilingual 403. A per-connection lookup failure also returns 403; it does not downgrade a capable host to permissive operation. Stop sandbox processes and close their sockets before restarting the host; socket identities can outlive their creating processes.
