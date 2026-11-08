---
description: "经过所有者授权的收件元数据与邮箱隔离告警。"
kind: "package-reference"
---

# @panedesk/dsh-client-ui-inbox

[English](README.md) | 中文

<a id="summary"></a>
## 概述

保留未默认启用的宿主观察适配器，供显式配置使用。已归档的客户端入口不提供顶栏按钮、弹层、资源或远端挂载。[消息交付提供者](../../session/message-delivery-local/README.zh.md)负责消息状态、元数据与隔离证据；本插件不发消息，也不开会话。参见[会话持久化](../../../docs/subsystems/persistence.zh.md)。

<a id="table-of-contents"></a>
## 目录

- [配置与使用](#configuration-and-use)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration-and-use"></a>
## 配置与使用

网页组合不装配此包。显式配置可用 `config: { enabled: true }` 挂载宿主适配器，但不会恢复已删除的界面。`enabled` 默认 false，`pollIntervalMs` 默认 1000，`pageSize` 默认 100。宿主只提供经过所有者授权、针对确切收件会话的观察流。缺少查询能力时报不可用；禁用适配器返回明确的禁用观察。不接受委托身份或调用者自报的发方权限。

宿主适配器在既有绑定查询有记录时返回发送方归属，同时返回创建时刻、优先级和既有消息状态。只请求路由元数据，不含消息正文、路径和凭据。已核验的邮箱隔离信息仍独立于生命周期状态，不完整结果明确标为不完整。

<a id="model-experience"></a>
## 模型体验

<a id="read-only-observation"></a>
### 只读观察

<a id="what-the-model-sees"></a>
#### 模型可见内容

`ui-inbox` 插件不增加工具、提示词或会话消息。

<a id="token-effect"></a>
#### Token 影响

收件读取不消耗模型 token。

<a id="kv-cache-effect"></a>
#### KV 缓存影响

插件不修改请求前缀，也不刷新缓存。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 适配器覆盖经过认证的所有者与本地提供者，不提供委托跨节点浏览。
- 没有隔离查询的旧提供者报告不可用，不编造空收件箱。没有元数据的旧状态保留未知字段。
- 轮询观察实时页面，不提供跨页原子快照。缺失的历史位绑定保持未知。

<a id="dev-note"></a>
### 开发备注

空客户端入口保留已有包清单兼容性，不保留已归档按钮的实现。宿主适配器和底层消息投递保持不变。
