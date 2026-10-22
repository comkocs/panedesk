---
description: "只读账本查询与导出服务定义。"
kind: "package-reference"
---

# @panedesk/dsh-ledger-query

[English](README.md) | 中文

## 概述

只读账本查询与导出服务定义。本包公开抽象 Cordis 服务与公共类型。消费者使用这些操作前，须由具体提供方实现。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

从包入口导入公共类型。本包仅用于 Host，不提供浏览器入口。

`panedesk --profile ledger messages --help` 列出严格校验的消息命令。投递命令使用可选的 `messageDelivery` 服务；消息查询使用可选账本的 `queryMessages` 和 `querySessions` 读取接口，按会话标识联读调用与消息命名空间。缺少提供方时返回明确错误，不改变既有账本命令。人工发送不虚构发送方会话；调用权限由投递提供方绑定。

`send` 只接受一个明确会话号或精确名字、消息类与正文；交接及回复的默认优先级为 `steer`，知会为 `queue`。回复须带 `--reply-to`。控制命令未带 `--expected-revision` 时读取当前修订号，保留显式传入的 `--operation-id`，并区分等待宿主的意图与已裁决结果。`send-batch --dry-run` 和 `resolve` 仅调用只读解析，不发布信箱记录、不唤醒。

`unanswered --older-than-minutes N` 向账本投影传递交接及回复的超龄筛选；默认排除撤回、作废、被拒及曾回应的消息，终态审计按选项处理。JSONL 导出保留稳定的创建时间／节点／消息排序、格式版本、排他续读游标与全量扫描完整性，不含消息正文。`--output` 新建仅属主可读写的文件；省略时在结构化结果中返回 JSONL。`watch --session ID` 流式输出回执 JSONL，支持排他的 `--cursor`。

消息命令退出码：0 表示成功或等待宿主的持久意图，1 表示执行失败，2 表示参数无效，3 表示能力不可用，4 表示投递或控制被拒，5 表示操作不存在或有类型标记的消息不存在，6 表示账本扫描不完整。

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
