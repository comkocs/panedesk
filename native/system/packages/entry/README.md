---
description: "JavaScript entry for the prebuilt Landlock launcher and asynchronous POSIX flock."
kind: "package-library"
---
# @panedesk/node-addon-system

English | [中文](README.zh.md)

The `./landlock-run` entry exports the Landlock launcher path, enforcement probe, grant arguments, and protocol constants. The independent `./flock` entry exports `tryLockExclusive(fd): Promise<void>`; importing either entry does not load `system.node`. The package has no root export.

The lock operation attempts `LOCK_EX | LOCK_NB` asynchronously. Keep the caller-owned descriptor open until completion; contention rejects with `EAGAIN`/`EWOULDBLOCK`, other syscall failures also reject, and errors carry their code, positive errno, and `syscall: 'flock'`. Native setup errors reject the same promise. Closing the last descriptor for the open file description releases the lock. The binding does not open, duplicate, close, or explicitly unlock descriptors.

`acquireExclusiveLockFile(path, options?)` returns a caller-owned handle for a dedicated lock file. POSIX opens it and calls the unchanged `tryLockExclusive`; existing consumers retain their original POSIX descriptors and retry loops. Only win32 uses libuv `UV_FS_O_EXLOCK` (`0x10000000`), without a native addon. Never pass readable data files: Windows excludes ordinary readers too. The file is opened but its contents are never read or written, and it must not be removed or replaced. Closing the handle or exiting releases ownership. Windows retries `EBUSY`/`EPERM` with bounded backoff, then reports `EAGAIN` with only the filename. Defaults are a 100 ms budget and 10 ms initial delay, doubling up to 40 ms; waiting callers pass their existing timeout and retry settings. `platform` and `open` options support injected platform tests.

Optional OS/CPU platform packages carry the binaries. Their `~x.y.z` dependency ranges allow later patches within the same minor version. Linux has `bin/landlock-run` and separate `bin/glibc/system.node` / `bin/musl/system.node`; macOS has `bin/system.node`. Missing or unloadable flock bindings reject acquisition, without installation-time compilation. Landlock remains a separate executable with its existing fail-closed protocol; unsupported kernels/platforms probe unusable.

The two C sources ship for auditability. See the workspace [architecture](../../docs/architecture.md), [support matrix](../../docs/support-matrix.md), and [CLI contract](../../docs/cli-contract.md).
