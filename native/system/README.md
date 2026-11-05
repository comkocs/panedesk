---
description: "Prebuilt system primitives for Linux confinement and POSIX Session write locks."
kind: "package-library"
---
# @panedesk/node-addon-system

English | [中文](README.zh.md)

## Summary

Use the Linux `landlock-run` executable to confine subprocesses, or the `./flock` entry to acquire a POSIX write lock. Platform packages contain the precompiled binaries; consumer installation never builds native code. Landlock policy and Session lifecycle remain with callers.

## Table of Contents

- [Use](#use)
- [Support](#support)
- [Development](#development)

## Use

`@panedesk/node-addon-system/landlock-run` exports `launcherPath`, `probe`, `grantArgs`, and `scopeOnlyArgs` for Landlock. Both launcher modes isolate abstract UNIX sockets on ABI 6 or later; older kernels omit that optional scope without refusing startup. `scopeOnlyArgs` is for commands already confined by mounts and adds no filesystem restrictions. Its executable name, flags, and failure semantics are defined by the [CLI contract](docs/cli-contract.md). Missing or inaccessible grant paths are omitted without granting their ancestors; other rule failures still prevent execution.

The [flock behavior contract](docs/flock-contract.md) maps descriptor, process, and advisory-lock semantics to independent native tests.

`@panedesk/node-addon-system/flock` exports `tryLockExclusive(fd): Promise<void>`. Keep the descriptor open until completion. Acquisition uses nonblocking exclusive flock; contention rejects with `EAGAIN` or `EWOULDBLOCK`, and closing the final descriptor for the open file description releases the lock. See the [entry README](packages/entry/README.md).

`@panedesk/node-addon-system/windows-private-files` exports synchronous metadata inspection, owner-only ACL creation and same-volume `MoveFileExW` replacement on Windows. The binding transfers no file contents and has no PowerShell fallback. Callers own path validation, fresh checks, file-handle identity comparisons and content flushing.

Importing any entry does not load an addon. A missing Landlock executable probes unusable; a missing flock binding rejects acquisition. Neither path compiles or silently grants unsupported behavior.

`@panedesk/node-addon-system/socket-cgroup` loads an instance-owned Linux query capability. `probe()` checks kernel socket attribution, not delegation; `query(tuple)` returns the TCP socket's cgroup ID from client-direction IPv4 or IPv6 endpoints in the caller's network namespace. Each synchronous netlink query is bounded to 100 ms and 256 datagrams; absent sockets, missing attributes and incomplete dumps throw. Product registration and descendant matching belong to the host. Linux 7.0 has been exercised; the minimum kernel version is not established.

## Support

Linux x64/arm64 packages contain the static Landlock executable and separate glibc/musl `system.node` files. macOS x64/arm64 packages contain `system.node` only. Windows x64/arm64 packages contain only the private-file Win32 `system.node`; POSIX flock and Windows lock-file behavior are unchanged. Landlock additionally needs an enforcing Linux kernel. The [support matrix](docs/support-matrix.md) names builders and verification owners.

On Landlock ABI 6 or newer, the launcher also applies `LANDLOCK_SCOPE_SIGNAL` and `LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET`: confined processes cannot signal processes outside their Landlock domain or connect to abstract UNIX sockets outside it, while the host can still cancel its children. Older ABIs omit both optional scopes without refusing startup and do not isolate same-user signals; `full`/`partial` describes filesystem enforcement only.

## Development

From this directory, `pnpm build:ts` builds the entry, `pnpm build:native` builds the host's declared native payload, and `pnpm build:test-oracle` builds an independent flock syscall fixture. Then `pnpm test` exercises entry, lock, packaging, and available kernel behavior. Linux requires musl-gcc for a complete build; macOS uses cc. Windows requires a matching MSVC developer environment, Node development headers under `include/node` beside `node.exe`, and a matching `node.lib` beside it. Windows compilation and real ACL acceptance must run on Windows; Linux tests cannot establish those results. The root `pnpm run build:native-system` builds only the current host addon for source tests.

The [architecture](docs/architecture.md), [packaging](docs/packaging.md), and [release procedure](docs/release.md) own implementation and publication details.

### Dev Note

None.
