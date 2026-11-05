---
kind: upgrade-guide
description: "以 IPC 启动的 CLI 现在会退出，除非 Node 命令行带有 --disable-sigusr1。"
---

# 以 IPC 启动 CLI 须带 `--disable-sigusr1`

[English](guide.md) | 中文

## 变更

在 Linux 与 macOS 上，以 IPC 通道启动的 CLI（例如 Node `fork`，或 `stdio` 含 `'ipc'`）以前在 Node 未带 `--disable-sigusr1` 时会原地重启。重启保留 PID、标准流、参数与环境，但丢掉 IPC 通道。现在 CLI 在读取 profile 与凭据前以中英错误退出，不再重启。Windows 不做此检查。

该开关必须出现在 Node 命令行上。经 `NODE_OPTIONS` 传入不算：CLI 只看 `process.execArgv`，其中不含 `NODE_OPTIONS` 里的选项。

不带 IPC 通道的启动方式不变：终端、shell 脚本、systemd、pnpm 脚本与 SDK 的管道启动在缺少该开关时仍原地重启。产品自带的启动器已经带上该开关。

## 迁移

1. 若自写启动器以 IPC 通道起 CLI，在 Node 命令行、脚本路径之前加上 `--disable-sigusr1`。Node `fork` 把 `'--disable-sigusr1'` 放进 `execArgv`。不要依赖 `NODE_OPTIONS=--disable-sigusr1`。
2. 确认子进程保持运行，且 IPC 通道仍能送达一条消息。缺少该开关会在加载 profile 前失败，而不是替换进程。
3. 终端、shell、systemd、pnpm 脚本与 SDK 管道启动不用改。不必从产品自带的启动器去掉该开关；去掉后，以 IPC 启动会安全拒绝。
