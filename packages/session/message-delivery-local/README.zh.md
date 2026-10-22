---
description: "私有本地文件信箱与基于租约的节点注册。"
kind: "package-reference"
---

# @panedesk/dsh-message-delivery-local

[English](README.md) | 中文

## 概述

本地文件信箱位于产品家目录下的 `messages/nodes/<nodeId>`。插件登记已持租约的 agent（智能体），发布运行时忙、闲及关闭中状态，并在资源释放后撤销登记。会话写租约始终是真源；注册不会获取或抢占租约。参见[会话持久化](../../../docs/subsystems/persistence.zh.md)。

## 目录

- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="dev-note"></a>
## 开发备注

配置显式提供 `nodeId`、`maxRecordBytes`、`lockTimeoutMs`、`lockRetryMs` 与 `scanIntervalMs`；可选的 `dshHome` 覆盖产品家目录。限额均为正整数，心跳间隔不得超过一秒。与 `agents` 和 `sessionPersistence` 一同挂载；可选的 `subprocess` 提供方提供平台进程创建证据。

每条记录采用排他临时文件创建、带版本及长度／摘要的封装、文件同步、原子发布及 POSIX 目录同步。每目标原生锁串行发布，并以明确的跳过区间恢复高水位。Linux 目录与文件要求仅属主可访问，并拒绝符号链接。Windows 在初始化存储前核验继承的 DACL 授权；其他主体的读写授权会被拒绝。未知进程身份保持不可用，绝不据此回收会话。

<a id="model-experience"></a>
## 模型体验

### 本地注册

#### 模型看到什么

注册与存储不发出模型消息、工具或提示词片段。

#### Token 影响

直接 Token 消耗为零。

#### KV Cache 影响

不修改请求或模型可见前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 仅注册与信箱存储不会启用消息裁决或投递。宿主必须保持会话租约获取、释放与 agent 生命周期的顺序。
- Windows 发布、身份与权限路径需要平台验证；Linux 测试只覆盖注入的 Windows 证据。同一用户的恶意进程不在存储隔离保证内。
