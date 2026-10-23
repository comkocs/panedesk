---
description: "同节点消息投递服务定义。"
kind: "package-reference"
---

# @panedesk/dsh-message-delivery

[English](README.md) | 中文

## 概述

同节点消息、收件设置、持久控制和运行时回执的服务定义。抽象服务 `MessageDelivery` 暴露 `ctx.messageDelivery`，不实现存储或投递。参见[会话持久化](../../../docs/subsystems/persistence.zh.md)。

`list` 接受正数 `limit` 和提供方签发的排他续页 `cursor`；继续实时扫描时须保持筛选条件相同。未答查询选择没有回复的 handoff/reply 消息，默认排除终态。应读取 `complete` 与 `nextCursor`，不能把未完成扫描当作完整的空结果。

## 目录

- [公开接口](#public-api)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="public-api"></a>
## 公开接口

`send`、`withdraw`、`edit`、`reprioritize`、`invalidate`、`status`、`operationStatus`、`list`、`resolve`、`sendBatch`、`configure` 和 `subscribe` 声明于 `src/index.ts`。公开输入和结果从 `src/types.ts` 导出。已关闭收件方可以拒绝即时投递，同时保留排队消息；离线控制只确认持久意图，不代表裁决完成。订阅迭代返回或服务销毁时释放资源。

`message/settings` 是读取时必需的持久事件。`message/state` 只在持久回执提交后发出。消息生命周期记录归独立消息账本命名空间，不进入调用日志。

<a id="dev-note"></a>
## 开发备注

公开声明由 `src/index.ts` 拥有；修改时同步双语说明与包内契约测试。

<a id="model-experience"></a>
## 模型体验

### 抽象服务

#### 模型看到什么

`ctx.messageDelivery` 声明抽象服务，不发布模型上下文。

#### Token 影响

直接消耗为零；不注册工具或提示词片段。

#### KV Cache 影响

加载这些定义不会改变请求或模型可见前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 投递、宿主裁决、存储校验和回执生产需要提供者实现。本包不会声称消息已经投递或回应。
