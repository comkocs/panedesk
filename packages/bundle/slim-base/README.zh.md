---
description: "Panedesk slim 预设的最小核心 bundle。"
kind: "package-bundle"
---

# @panedesk/slim-base

[English](README.md) | 中文

## 概述

`@panedesk/slim-base` 是 `@panedesk/dsh-base` 的逐行子集，提供最小 headless 核心、上下文压缩、大输出溢写、工具调用超时保护和 `AGENTS.md` 加载。它面向默认 slim 预设的用户，随 `panedesk` 启动器一同安装，作为核心 bundle 使用。它提供 profile 组合，而非独立命令；`panedesk "task"` 选择 slim，并配合 `@panedesk/slim-headless` 一次性任务 bundle。

## 已知限制与延期工作

- 这个 bundle 只是完整组合的子集；slim 不随附模型路由，用户必须先配置提供商 overlay，才能运行任务。
