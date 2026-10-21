---
description: "离线账本应用插件骨架。"
kind: "package-reference"
---

# @panedesk/dsh-ledger-app

[English](README.md) | 中文

## 概述

离线账本应用插件骨架。本包公开经校验的配置和无操作函数插件。加载时不注册钩子、定时器、命令或服务。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

从包入口导入公共类型。本包仅用于 Host，不提供浏览器入口。

<a id="model-experience"></a>
## 模型体验

### 未启用的骨架

#### 模型可见内容

`src/index.ts` 不注册工具、提示或消息，模型不会收到本包添加的内容。

#### Token 影响

骨架不发起模型请求，不增加输入或输出 token。

#### KV Cache 影响

骨架不修改请求前缀，也不建立或刷新缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 本包仅提供声明与骨架；存储、网络请求、进程观测、命令执行及 profile 组合均未在此实现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
