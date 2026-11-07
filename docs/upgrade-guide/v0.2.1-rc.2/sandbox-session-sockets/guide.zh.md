---
kind: upgrade-guide
description: "本地沙箱命令不再继承对常规宿主会话套接字目录的访问，并要求匹配的原生启动器。"
---

# 沙箱会话套接字

[English](guide.md) | 中文

## 变更

Bubblewrap 命令在两种受限模式下均使用私有临时与运行时目录，并清除宿主会话指向变量。依赖宿主 tmux、screen、D-Bus、X11 或 Wayland 会话的工具不再能经这些目录工作。Seatbelt profile 拒绝临时及配置会话目录下的 UNIX 出站连接。Linux 启动器在 Landlock ABI 6 及以上可选隔离抽象 UNIX 套接字；旧内核仍启动命令。仅用 Landlock 的命令仍可访问具名套接字路径，并在常规会话落点存在时提示。

## 迁移

1. 将原生入口和平台包一同升级至 `@panedesk/node-addon-system` 0.1.3。自定义打包必须重编 `landlock-run`；旧二进制会拒绝 `--scope-only`。
2. 工作区应位于 `TMUX_TMPDIR` 和 `XDG_RUNTIME_DIR` 之外：会话遮挡会隐藏重叠工作区内容。用普通文件而非宿主会话套接字交换工具输入输出，不要仅为恢复会话访问而选择 full-access。
3. 确认普通工作区命令和私有临时文件仍能工作，且 bubblewrap 内无法访问专用测试会话套接字。Seatbelt 仍需 macOS 原生验收。阅读[其余隔离限制](../../../../docs/user/platform-behavior.zh.md#sandbox-session-isolation-and-limitations)；目录遮挡不提供一般网络隔离。
