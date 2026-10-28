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

查询前，如果最近一次主进程的 `$PANEDESK_HOME/run/kernel-status.json` 记录账本或缓存层不可用，或状态无法读取，stderr 会以 `Session ledger not mounted: <cause>` 明示「账本未挂」。pid 已退出或状态早于 `run/kernel-boot.json` 时附加 `(may be stale)`。离线查询不覆盖主进程状态件。本地 `ledgerQuery` 缺席时明示禁用、导入或等待注入细因，并以 1 退出。stdout 保留机器可读 JSON；既有命令诊断使用英文。

将 `PANEDESK_SEAT_MAX_DECISION_BYTES` 设为目标 writer 的 `maxDecisionBytes`，或在 `ledger-app` 行的 `engineReader` 中显式设置 `home`、`nodeId` 与 `maxDecisionBytes`。仅 `engine` 命令参数挂载引擎与闸只读服务；其他命令保留默认插件行及服务。不推断帧上限。没有 reader 配置时，引擎查询返回不可用。引擎命令禁用本地消息投递，避免初始化邮箱。reader 无需挂载 writer 即支持 `engine events`、`pending`、`export`、`verify` 与 `gates`；导出在 `content` 中返回 JSONL，不写入输出路径。闸查询从同一个已验证账本前缀重算每个已记录修订的命中次数、到期及上限证据。未记录的策略不列出，未记录的上限为 `unknown`；客户端工作树上限使用已记录的计数和界限。分页游标绑定观测水位，新提交后失效。

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
