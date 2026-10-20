---
description: "Panedesk 启动器可选的完整预设承载包。"
kind: "package-bundle"
---

# @panedesk/full

[English](README.md) | 中文

## 概述

`@panedesk/full` 承载上游 DSH 的 headless 组合、web/ACP/SDK 应用、可选 bundle 和插件管理器。需要默认 slim 预设之外这些能力的用户，将它安装在 `panedesk` 启动器旁，即可启用 `full`、`web`、`acp` 和 `sdk` profile。它补充启动器，而不提供独立命令；运行 `panedesk full` 选择完整 headless 预设。

## 已知限制与延期工作

- 这个可选承载包必须安装在启动器旁；仅安装 slim 启动器不会使完整 profile 可用。
