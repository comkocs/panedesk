---
description: "可选的账本所有者核对与进程看护。"
kind: "package-reference"
---

# @panedesk/dsh-ledger-watch

[English](README.md) | 中文

## 概述

可选的账本所有者核对与进程看护。有 Session 账本提供方时，插件在启动时核对配置的本地节点，或在显式启用后持续轮询。释放时停止看护并等待当前轮次完成；没有账本提供方时保持不活动。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

持久确认死亡所有者后，观察器在较慢的调用修复前，为该精确身份发送 `ledger-watch/owner-settled`。未知所有者证据或竞争中的正常终态不授权释放。通知失败会被容纳，不跳过既有修复；资源释放由消费方负责。

从包入口导入公共类型。本包仅用于 Host，不提供浏览器入口。

<a id="model-experience"></a>
## 模型体验

### 所有者核对

#### 模型可见内容

`src/index.ts` 不注册工具、提示或消息，模型不会收到本包添加的内容。

#### Token 影响

看护器不发起模型请求，不增加输入或输出 token。

#### KV Cache 影响

看护器不修改请求前缀，也不建立或刷新缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 核对需要配置的本地节点的权威证据；未知进程证据不授权释放所有者。持久结算通知后的资源释放由消费方处理。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
