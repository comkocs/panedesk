---
description: "离线账本应用插件骨架。"
kind: "package-bundle"
---

# @panedesk/dsh-ledger-app

[English](README.md) | 中文

## 概述

离线账本应用组合包。配置挂载会话账本、查询服务、本地消息投递，以及 Agent 与 Session 登记、投影和 JSONL 持久化。投递从账本取得本节点身份。组合包不挂载模型适配器、Agent 循环或指令订阅；离线命令不创建运行中的模型会话。

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

### 离线命令装配

#### 模型可见内容

`src/index.ts` 不注册工具、提示或消息，模型不会收到本包添加的内容。

#### Token 影响

骨架不发起模型请求，不增加输入或输出 token。

#### KV Cache 影响

骨架不修改请求前缀，也不建立或刷新缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 本配置不运行收件 Agent；在线收件方属于其他运行中的 profile。离线查询没有输入准备生命周期，因此不挂载指令订阅。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
