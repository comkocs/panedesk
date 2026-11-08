---
description: "dsh Web 客户端的只读子代理父子树，逐节点带监测视图。"
kind: "package-reference"
---

# @panedesk/dsh-client-ui-subagent-tree

[English](README.md) | 中文

## 概述

从会话头在右栏打开本会话的子代理树。嵌套行展示状态、模型、token 合计与缓存命中率。监测按钮打开只读状态（在跑、等待或结束原因）、模型、五类 token、缓存命中率、已用时、最近工具调用及其时刻、所属位与关联单。树视图只读，停止沿用既有会话控制。内置子代理模型名来自会话转录中最近观测的请求头或助手响应，不从账本配置默认值回填。外部模型名来自派遣登记；缺失保持未知。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

紧凑的 28px 药丸保留既有头部高度，只出现在已打开会话的头部动作区，排在子代理目录药丸之后；`minimal` 预设不显示该入口，不占首屏，也不上引导页。点按后在右栏以 `subagenttree` 页签类型打开本会话的树页，资源地址 `dsh-resource://subagenttree/session/<sessionId>`。页签按部署配置的节拍轮询 `subagentTree.read` Remote，并以中英文案渲染八态（默认、加载、空、错误、无权限、禁用、成功、失败）。节点行按树深缩进，前置状态点，标签取会话投影（缺失回退会话号）。监测事实逐项给出数值或明示未知；用量证据覆盖（无 / 部分 / 完整）如实展示，不填零。

「Panedesk 特色设置」页提供**外部子代理登记文件**，值保存在主机设置服务中。留空关闭外部读取；否则填写主机可读的 UTF-8 JSONL 文件。每次刷新读取该文件，跳过无效行，按 `子会话号` 保留最后一条有效记录，再筛选 `父会话号` 等于当前显示会话的记录。外部节点带标记，作为叶节点与内置子节点同列。标题取 `短题` 或 `类型`，模型取 `实际模型` 或 `模型`，监测视图展示 `起` 与 `止`。`在途` 表示运行中；缺少 `状态` 按结束处理；结束记录仅在 `退出码` 为零时显示完成。Token 总计为 `用量` 中各模型的 `inputTokens + outputTokens` 之和。文件不可读时显示警告，但不隐藏内置节点，后续刷新会重试。已打开的监测弹窗跟随刷新后的数值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

宿主半在核验调用方为已认证所有者后，只暴露一个 Remote：`subagentTree.read(request)`。树直接读去重后的 `sessionLedger` 快照（不改 `ledger-query`）：成员资格沿能到达请求会话的 `parentSessionId` 链，环退化为排除，账本行序即观测序。逐会话 token 列对带用量的调用结束求和；短档写仅在调用可证分档缓存写时存在，未分档写只保留总计；缓存命中 = 缓存读 ÷（未缓存输入 + 缓存读 + 已观测写），零分母为未知。状态在最新驻留有结束帧时为 `finished` 并带账本结束原因，否则有未配对 `wait/start` 时为 `waiting`，否则 `running`；存活来自进程观测。内置派遣在执行前写入关联父会话的运行开始记录，结算后保留结束记录，按预设类型派遣也走此路径。模型号与最近工具调用经 `sessionQuery.readSession` 折叠会话自身日志后缀，跳过 fork 继承前缀；请求头在首次助手响应前提供已观测路由，随后以响应报告的模型为准；`sessionQuery` 缺失标记模型不可用，日志不可读标记不可读——两者在线上均保持未知。

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
