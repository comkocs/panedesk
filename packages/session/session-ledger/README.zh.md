---
description: "持久化调用与生命周期账本服务定义。"
kind: "package-reference"
---

# @panedesk/dsh-session-ledger

[English](README.md) | 中文

## 概述

持久化调用与生命周期账本服务定义。本包公开抽象 Cordis 服务与公共类型。消费者使用这些操作前，须由具体提供方实现。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

从包入口导入公共类型。本包仅用于 Host，不提供浏览器入口。

提供方接受 `Config.waitTools`，并实现 `registerWaitTool(name, category)`，登记可信运行时分类（`sleep`、`external-marker`、`subagent`）。运行时登记优先于配置默认值；存活登记的类别冲突时拒绝，幂等释放函数只释放自己的登记。未登记工具保持 `unclassified`；模型输出不得定义类别。

`appendArtifact` 在账本自管路径写入受限的 `partial-response` 或 `keepalive-request` JSON 片段。`(callId, kind, seq)` 标识精确 UTF-8 内容字节：相同重放返回 `existing`，异内容返回 `conflict`，不覆盖。序号从零开始且连续。成功应答须等待文件及必要目录同步。`finishArtifact` 核对末片并持久化收尾；之后拒绝新片段，但精确重放仍幂等。`LedgerCallFinish.artifacts` 携带返回引用，不携带原始内容。

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
