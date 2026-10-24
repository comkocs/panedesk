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

从包入口导入公共类型。本包仅用于 Host，不提供浏览器入口。`/messages` 插件只注册 `messageLedger`，不注册 `sessionLedger`，也不挂运行、调用和工具记账监听。可选存储与锁设置与完整提供方一致，`nodeId()` 解析同一份持久化 `ledger/v1/node-id`。默认 bundle 使用此消息专用入口；记账 profile 保留完整提供方。

提供方接受 `Config.waitTools`，并实现 `registerWaitTool(name, category)`，登记可信运行时分类（`sleep`、`external-marker`、`subagent`）。运行时登记优先于配置默认值；存活登记的类别冲突时拒绝，幂等释放函数只释放自己的登记。未登记工具保持 `unclassified`；模型输出不得定义类别。

`appendArtifact` 在账本自管路径写入受限的 `partial-response` 或 `keepalive-request` JSON 片段。`(callId, kind, seq)` 标识精确 UTF-8 内容字节：相同重放返回 `existing`，异内容返回 `conflict`，不覆盖。序号从零开始且连续。成功应答须等待文件及必要目录同步。`finishArtifact` 核对末片并持久化收尾；之后拒绝新片段，但精确重放仍幂等。`LedgerCallFinish.artifacts` 携带返回引用，不携带原始内容。

`JournalSessionLedger.messages()` 将不含正文的 `message/state` 事实存入 `ledger/messages/v1/<nodeId>/events/<UTC-date>/`，独立于保持不变的调用命名空间 `ledger/v1/`。消息封套从 `schemaVersion: 1` 起步；人工来源可以没有会话或运行号。事件身份由节点、消息、状态版本与转移派生。原生写锁串行保护唯一状态版本；相同重放同步并确认既有字节，不同重放拒绝。每次追加创建受限权限、带校验的 JSONL 段，并同步文件与目录。中断半行保留不动，后续写入另起段；读取明确报告不完整存储，不隐藏半行或损坏。消息正文被拒绝。

存储布局：各账本根目录在节点身份或事件目录旁保留 `writer.lock`，从不锁数据段。Linux 与 macOS 保持既有描述符 flock、inode 校验及重试循环。仅 win32 对专用文件使用独占共享打开；`EBUSY`/`EPERM` 从 `lockRetryMs` 退避到 40 毫秒，在 `lockTimeoutMs` 上限内重试，超时以 `EAGAIN` 报告且只携带锁文件名。锁文件内容从不读写；关闭句柄或进程退出即释放所有权。不得删除或替换锁文件。

`queryMessages` 先折叠全部版本，再按当前状态、类别、来源或目标会话及半开创建时间筛选；各状态时刻保留首次观察，包括回合中断后的首次注入时刻。未回应交接包含回复类与已关目标的待收消息，排除任何已有回应的消息，默认不列终态，除非显式要求。投影游标标识末条消息，日志游标标识末条事件。`exportMessages` 即使结果为空也输出带版本的完整性头。`querySessions` 按参与双方的会话号联读调用与消息，无会话的人工来源消息单列。联读组合两处独立加锁的读取，不提供跨命名空间原子检查点；消息永不计入调用汇总。

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
