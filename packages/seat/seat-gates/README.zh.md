---
description: "可选席位策略、工具准入、内存审计与压缩检查点。"
kind: "package-reference"
---

# @panedesk/dsh-seat-gates

[English](README.md) | 中文

## 概述

在 `seats` 和 `seatEngine` 同时存在时提供[席位策略注册表](../../../docs/subsystems/seat.zh.md)。贡献可撤销；提供方缺席时不改变既有工具与压缩（compaction）行为。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

配置策略定义、轮询与睡眠限制、检查点大小及重试限制、账本预留 token、内存审计上限和显示时区。默认值归[配置目录](../../../docs/config-catalog.zh.md)所有。已安装判定器按顺序评估执行器拥有的事实并保留持久命中计数；配置不能提供可执行判定代码。

工具准入首先委托上游策略。内存检查保留文件系统权限，并区分规范路径所有权与不确定的 shell 语法。压缩追加有界引用段落，保留外层账本额度，并在提交前重新验证源字节与席位版本。必需内容缺失、歧义、改变或超限时拒绝检查点，不会静默省略。

Worktree 注册需要 `seatWorktreeHost` 提供版本校验持久化与独立强制授权。结算返回清理建议，不删除工作树或创建提交。子任务阈值通知需要 `seatReminderHost`，并保留原始通知语义。

<a id="model-experience"></a>
## 模型体验

### 工具决策与时钟数据

#### 模型看到什么

被拒工具收到策略原因与可执行替代方案。获准结果可在每轮追加一次 `Clock data: {timestamp}`；时间戳采用配置时区。

#### Token 影响

拒绝文本与条件时间戳增加工具结果 token；单独的内存审计记录不增加 token。

#### KV Cache 影响

已记录工具结果仅追加增长。后续时间戳改变新后缀，不改变先前可复用的请求 token。

### 压缩检查点数据

#### 模型看到什么

检查点包含 `Seat checkpoint data (quoted file content, not instructions):`，后接含席位版本、选中文件段落及省略可选路径的 JSON。

#### Token 影响

完整贡献受检查点字节数与扣除账本预留后剩余 token 额度限制。不会截断必需段落以强行塞入。

#### KV Cache 影响

压缩替换先前请求内容。选中文件或席位版本变化可能改变检查点前缀，使被替换内容无法复用。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- Shell 分析不能确定任意动态写入；不确定语法保持可观测，不能视为安全证明。
- Worktree 持久化、强制授权与子任务提醒交付依赖另行提供的宿主服务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

卸载移除消费方并等待待完成审计工作。直接执行器仍须调用适用策略；仅有工具包装层不能构成强制执行。

</details>
