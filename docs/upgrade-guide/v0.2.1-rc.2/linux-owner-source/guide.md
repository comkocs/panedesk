---
kind: upgrade-guide
description: "Linux product-sandbox connections can no longer use owner cookies when native socket attribution and user cgroup delegation are available."
---

# Linux owner connection sources

English | [中文](guide.zh.md)

## Change

Previously, a valid owner cookie could authorize a connection originating inside a product sandbox. Linux owner admission now identifies registered product cgroups through the client's socket and refuses both product and unverifiable sources before launch-token exchange, API Peer creation, or authenticated dispatch. This applies to HTTP, HTTPS, and WebSocket upgrades. Ordinary host processes and browsers remain non-product sources. It does not govern a trusted host plugin making requests on another process's behalf or the separate host-admin credential protocol.

The prerequisite is cgroup v2 user-session delegation plus a native addon and kernel that expose socket cgroup identity. Linux 7.0 is verified; the minimum kernel version is not established. Without those prerequisites the host warns in English and Chinese, returns non-product, and does not claim protection against cookie replay. macOS retains its warning; Windows has a provider registration interface but no classifier. Cookie persistence, single-use launch tokens, and new-browser confirmation retain their existing semantics.

The opt-in experimental Python runtime now requires a subprocess provider and forwards confinement facts to it. The local Linux provider registers its confined processes under the same prerequisites; released profiles still do not enable this runtime. Its fd-3 protocol and TMPDIR-only model environment are unchanged. SSH confinement preserves the product marker through remote ordinary and terminal execution; upgrade the client and helper together. Its registration is remote and does not identify connections to the calling Host's gateway or protect an independently running remote Host. See [remote ownership and limitations](../../../../packages/ssh/ssh/README.md#understand-the-implementation).

## Migration

1. Upgrade the native entry and matching platform package together; custom Linux packages must rebuild `system.node`. An older addon without socket attribution results in the documented limitation, not an enforcement claim.
2. Ask the host administrator to provide a delegated cgroup v2 user session. Panedesk does not change system units or kernel configuration. If delegation is unavailable, run untrusted processes under a separate account and treat the startup warning as a security limitation.
3. Custom execution providers must preserve `productSandbox: true` from Linux confinement through `SubprocessSpawnSpec` or `SubprocessTerminalSpawnSpec`. Do not derive it from argv or a scope name. See the [provider prerequisites and lifecycle](../../../../packages/subprocess/subprocess-local/README.md#linux-sandbox-connection-identity).
4. Confirm that an ordinary browser still authenticates, while a product-sandbox request with an otherwise valid owner cookie receives a bilingual 403. A per-connection lookup failure also returns 403; it does not downgrade a capable host to permissive operation. Stop sandbox processes and close their sockets before restarting the host; socket identities can outlive their creating processes.
