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

配置显式提供 `nodeId`、`maxRecordBytes`、`maxContentBytes`、`maxBatchSize`、`lockTimeoutMs`、`lockRetryMs`、`scanIntervalMs` 与 `watch`；可选的 `dshHome` 覆盖产品家目录。限额均为正整数，扫描间隔不得超过一秒。与 `agents`、`sessions` 和 `sessionPersistence` 一同挂载；可选的 `subprocess` 与消息账本提供方提供平台身份和回执记账。

每条记录采用排他临时文件创建、带版本及长度／摘要的封装、文件同步、原子发布及 POSIX 目录同步。每目标原生锁串行发布，并以明确的跳过区间恢复高水位。Linux 目录与文件要求仅属主可访问，并拒绝符号链接。Windows 在初始化存储前核验继承的 DACL 授权；其他主体的读写授权会被拒绝。未知进程身份保持不可用，绝不据此回收会话。

<a id="model-experience"></a>
## 模型体验

### 本地注册

#### 模型看到什么

投递消息保留发送方铸造的身份，以用户输入进入模型。作废保留原历史，并另行排入包含原号与原因的 steer 通知。回执不进入收件箱。

#### Token 影响

投递正文与作废通知消耗输入 Token；注册与回执不消耗。

#### KV Cache 影响

新投递输入扩展请求历史。作废追加通知，不重写原有模型可见前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 服务在队列入队前裁决发送与控制，留存控制结果供重放，并在恢复投递前还原持久输入阶段。宿主必须保持会话租约获取、释放与 agent 生命周期的顺序。改档依赖支持优先级的队列实现。
- 政策由 `sessionProjections` 从持久 `message/settings` 事件投影，支持不写检查点的宿主冷读。`handoff-only` 收回复、拒知会；属主复核新消息政策，但不清除已接纳输入。开关开启时，闲态交接与回复显式请求调度器唤醒；知会保持被动。清单试算不写信箱、不唤醒，同一解析会话只发一次。回执订阅按发布顺序游标续取，不进入收件箱。属主测试使用调度替身；真实 headless 组合、父子隔离与内核唤醒保证仍需集成验证。
- Windows 发布、身份与权限路径需要平台验证；Linux 测试只覆盖注入的 Windows 证据。同一用户的恶意进程不在存储隔离保证内。
