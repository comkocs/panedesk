---
description: "Panedesk slim 预设的一次性任务 bundle。"
kind: "package-bundle"
---

# @panedesk/slim-headless

[English](README.md) | 中文

## 概述

`@panedesk/slim-headless` 在 `@panedesk/slim-base` 之上组合 `@panedesk/dsh-headless` 一次性任务执行器，并采用 Panedesk 默认配置。它随 `panedesk` 启动器一同安装，面向使用默认 slim 预设、每次运行一个任务的用户。它是 profile bundle，而不是独立可执行程序：通过 `panedesk "task"` 调用，使用 slim 核心和此执行器打印最终答案，然后退出。

## 已知限制与延期工作

- slim 不随附模型路由；运行任务前必须配置提供商 overlay。执行器每次调用处理一个任务，不提供交互式后续会话。
