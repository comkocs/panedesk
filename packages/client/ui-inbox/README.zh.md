---
description: "经过所有者授权的收件元数据与邮箱隔离告警。"
kind: "package-reference"
---

# @panedesk/dsh-client-ui-inbox

[English](README.md) | 中文

<a id="summary"></a>
## 概述

在既有会话头增加只读收件入口。启动前首页没有收件入口。[消息交付提供者](../../session/message-delivery-local/README.zh.md)负责消息状态、元数据与隔离证据；本插件不发消息，也不开会话。参见[会话持久化](../../../docs/subsystems/persistence.zh.md)。

<a id="table-of-contents"></a>
## 目录

- [配置与使用](#configuration-and-use)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration-and-use"></a>
## 配置与使用

网页组合包含惰性 `ui-inbox` 条目，产品档案以 `config: { enabled: true }` 启用。`enabled` 默认 false，`pollIntervalMs` 默认 1000，`pageSize` 默认 100。宿主只提供经过所有者授权、针对确切收件会话的观察流。缺少查询能力时报不可用；禁用适配器返回明确的禁用观察。不接受委托身份或调用者自报的发方权限。

收件列表在既有所有者授权绑定查询提供证据时显示发方位，否则显示人工或未知归属，同时显示创建时刻、优先级和六个既有消息状态。行按创建时刻再按消息标识排序。只请求路由元数据，不含消息正文、路径和凭据。仅当所查邮箱有已核验隔离证据时显示告警；点击后查看本地化原因。不向生命周期枚举添加隔离状态。

面板区分默认、加载、空、错误、无权限、禁用、成功和刷新失败观察。不完整结果明确标为不完整。资源拥有订阅生命周期；关闭弹层不会创建另一套轮询。插件释放时移除远端挂载以及全部界面、资源和语言贡献。

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

浏览器只读取标准资源席位。宿主按收件会话过滤既有交付查询，并用既有所有者权限读取可选发方位标签。
