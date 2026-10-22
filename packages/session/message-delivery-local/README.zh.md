---
description: "未启用的本地消息提供者骨架。"
kind: "package-reference"
---

# @panedesk/dsh-message-delivery-local

[English](README.md) | 中文

## 概述

未启用的本地消息提供者骨架。具名函数 `apply` 不执行操作，也不注册监听器或服务。参见[会话持久化](../../../docs/subsystems/persistence.zh.md)。

## 目录

- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="dev-note"></a>
## 开发备注

公开声明由 `src/index.ts` 拥有；修改时同步双语说明与包内契约测试。

<a id="model-experience"></a>
## 模型体验

### 未启用骨架

#### 模型看到什么

`apply` 不发出消息、工具或提示词片段。

#### Token 影响

直接 Token 消耗为零。

#### KV Cache 影响

不修改请求或模型可见前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 本地消息提供者尚未实现。加载本骨架不会启用消息投递或规矩订阅。
