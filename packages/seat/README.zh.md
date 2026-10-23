---
description: "显式启用的节点本地席位编排及其提供方与消费方。"
kind: "package-group"
---

# seat/ — 可选席位编排

[English](README.md) | 中文

## 概述

定义具名席位配置与节点本地窗口操作、持久准入与恢复、可选策略，以及 CLI（命令行界面）、Remote 和模型消费方。安装不会启用自动开窗，也不安装后台服务。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`seat/`](seat/README.zh.md) | 共享服务定义与操作类型 |
| [`seat-local/`](seat-local/) | 本地定义与会话操作 |
| [`seat-engine/`](seat-engine/README.zh.md) | 持久队列、恢复、资源预算及回调 |
| [`seat-gates/`](seat-gates/README.zh.md) | 可选策略、内存审计与检查点消费方 |
| [`tool-seat/`](tool-seat/README.zh.md) | 面向模型的窗口、等待、报告与目录工具 |
| [`seat-remote/`](seat-remote/README.zh.md) | 经过认证的 Remote 投影与可选 webhook 入口 |
| [`seat-app/`](seat-app/README.zh.md) | 显式启动器配置组合包与 CLI 消费方 |

<a id="related-documentation"></a>
## 相关文档

- [席位子系统](../../docs/subsystems/seat.zh.md)拥有本组类型定义与服务语义。
- [配置目录](../../docs/config-catalog.zh.md)记录提供方配置。
- [工具目录](../../docs/tool-catalog.zh.md#panedeskdsh-tool-seat)记录模型工具 schema。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本地与引擎提供方依赖共享服务定义，不依赖彼此实现。引擎记录与会话、计费及消息日志保持独立。

</details>
