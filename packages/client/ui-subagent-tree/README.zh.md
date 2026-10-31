---
description: "dsh Web 客户端的只读子代理父子树，逐节点带监测视图。"
kind: "package-reference"
---

# @panedesk/dsh-client-ui-subagent-tree

[English](README.md) | 中文

## 概述

从会话头在右栏打开本会话的子代理树。嵌套行展示状态、模型、token 合计与缓存命中率。监测按钮打开只读状态（在跑、等待或结束原因）、模型、五类 token、缓存命中率、已用时、最近工具调用及其时刻、所属位与关联单。视图不提供写操作，停止沿用既有会话控制。模型名只来自会话转录；缺失保持未知，不从账本回填。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

紧凑的 28px 药丸保留既有头部高度，只出现在已打开会话的头部动作区，排在子代理目录药丸之后；不占首屏，也不上引导页。点按后在右栏以 `subagenttree` 页签类型打开本会话的树页，资源地址 `dsh-resource://subagenttree/session/<sessionId>`。页签按部署配置的节拍轮询 `subagentTree.read` Remote，并以中英文案渲染八态（默认、加载、空、错误、无权限、禁用、成功、失败）。节点行按树深缩进，前置状态点，标签取会话投影（缺失回退会话号）。监测事实逐项给出数值或明示未知；用量证据覆盖（无 / 部分 / 完整）如实展示，不填零。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

宿主半在核验调用方为已认证所有者后，只暴露一个 Remote：`subagentTree.read(request)`。树直接读去重后的 `sessionLedger` 快照（不改 `ledger-query`）：成员资格沿能到达请求会话的 `parentSessionId` 链，环退化为排除，账本行序即观测序。逐会话 token 列对带用量的调用结束求和；短档写仅在调用可证分档缓存写时存在，未分档写只保留总计；缓存命中 = 缓存读 ÷（未缓存输入 + 缓存读 + 已观测写），零分母为未知。状态在最新驻留有结束帧时为 `finished` 并带账本结束原因，否则有未配对 `wait/start` 时为 `waiting`，否则 `running`；存活来自进程观测。模型号与最近工具调用经 `sessionQuery.readSession` 折叠会话自身日志后缀，跳过 fork 继承前缀；`sessionQuery` 缺失标记模型不可用，日志不可读标记不可读——两者在线上均保持未知。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 只读会话树

#### 模型看到什么

无。`subagentTree.read(request)` 为客户端界面读取账本与转录；不发送任何提示段，不调用面向模型的工具。

#### Token 影响

无。读取不增加任何模型 token。

#### KV 缓存影响

无。读取从不改动请求 token。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **转录读取串行且无上限** —— 每次读取按账本序逐节点经 `sessionQuery.readSession` 读自身日志后缀；树越宽单次读取越慢，暂无逐节点上限。
- **等待按等待对计数** —— `waiting` 比较未配对的 `wait/start` 与 `wait/end` 辅助事实；从不配对等待的提供方会显示 `running`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
