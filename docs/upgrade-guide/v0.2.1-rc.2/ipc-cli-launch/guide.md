---
kind: upgrade-guide
description: "An IPC-started CLI now exits unless Node was started with --disable-sigusr1 on its command line."
---

# IPC CLI launch requires `--disable-sigusr1`

English | [中文](guide.zh.md)

## Change

On Linux and macOS, a CLI started with an IPC channel (for example Node `fork`, or `stdio` that includes `'ipc'`) used to restart in place when Node was not started with `--disable-sigusr1`. That restart kept the PID, standard streams, arguments, and environment, but dropped the IPC channel. The CLI now exits with a bilingual error before it reads a profile or credentials, and it does not restart. Windows does not perform this check.

The flag must appear on the Node command line. Passing it through `NODE_OPTIONS` does not count: the CLI reads `process.execArgv`, which does not include options from `NODE_OPTIONS`.

Launches without an IPC channel are unchanged: a terminal, a shell script, systemd, a pnpm script, and an SDK pipe launch still restart in place when the flag is absent. Shipped launchers already pass the flag.

## Migration

1. If your launcher starts the CLI with an IPC channel, add `--disable-sigusr1` to the Node command line, before the script path. For Node `fork`, set `execArgv` to include `'--disable-sigusr1'`. Do not rely on `NODE_OPTIONS=--disable-sigusr1`.
2. Confirm the child stays up and the IPC channel still delivers a message. A missing flag fails before profile loading instead of replacing the process.
3. Leave terminal, shell, systemd, pnpm-script, and SDK pipe launches unchanged. Removing the flag from a shipped launcher is not required and will make an IPC launch fail closed.
