---
description: "经过认证的 Remote 席位操作与显式启用的 webhook 入口。"
kind: "package-reference"
---

# @panedesk/dsh-seat-remote

[English](README.md) | 中文

## 概述

通过 `seats` Remote 命名空间投影[席位服务](../../../docs/subsystems/seat.zh.md)。业务操作仍归节点本地提供方所有；本包不创建替代引擎。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

与经过认证的 Remote 运行时及席位提供方一同挂载。调用要求所有者主体。适配器从调用和本地引擎身份推导权限，拒绝注入的权限字段，并强制远端开窗经过提供方的自动路径。提供方缺席时返回明确的不可用错误。

仅在 `webhook` 配置了路径、有界请求体与响应计时策略、允许时钟偏差和引用凭据的明确来源时，才存在 webhook 入口。每个配置来源以 HTTP 白名单中的同一标识登记到引擎；卸载时排空请求并移除路由与来源注册。正确签名进入持久准入，错误签名只产生拒绝审计。来源回调只在本地确认，不发送出站 HTTP。被拒来源尝试通过引擎持久审计。不能将凭据值放入来源记录或查询输出。

<a id="model-experience"></a>
## 模型体验

### Remote 请求

#### 模型看到什么

`seatRemote` 响应不是模型消息。获准开窗或唤醒内容归席位提供方及既有消息投递所有。

#### Token 影响

解析、认证、查询与 HTTP 确认不增加模型 token。获准操作可能触发提供方拥有的模型工作。

#### KV Cache 影响

Remote 投影不替换请求前缀，也不刷新缓存。提供方拥有的模型操作保留各自缓存行为。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 实时执行需要本地席位提供方；认证访问不授予跨节点执行权限。
- Webhook 认证与审计需要配置的凭据及引擎服务；证据缺失不能视为已认证入口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

权限推导保留在服务端，投影中保留类型化拒绝、分页完整性和操作标识。

</details>
