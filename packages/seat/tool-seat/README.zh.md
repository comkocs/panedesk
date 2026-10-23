---
description: "用于席位窗口、非阻塞等待、报告与注册目录的可选模型工具。"
kind: "package-reference"
---

# @panedesk/dsh-tool-seat

[English](README.md) | 中文

## 概述

公开[席位服务](../../../docs/subsystems/seat.zh.md)的模型消费方。窗口、等待与报告工具仅在 `tools` 和 `seats` 存在时注册；目录工具要求 `tools` 和 `seatDirectories`。卸载提供方会移除其贡献。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

与获授权提供方一同挂载插件。`seat_windows` 通过提供方拥有的只读 `seatLocalRead` 能力读取；等待、取消等待、自报及撤销自报通过独立的 `seatLocalSession` 能力，以调用者的真实在线 Session 取得仅自身会话的写权限；目标会话不匹配、会话已替换或提供方已卸载时拒绝。该能力不暴露通用授权入口，`seatLocalRead` 仍只读；其他写工具仍要求原有授权服务。操作标识由调用会话与工具调用推导。窗口操作指定精确席位或会话；关闭需要观察到的状态版本，并拒绝忙碌窗口。目录操作使用注册根标识并保留提供方权限，不接受任意授权路径。

`seat_wait` 注册明确对象，并在注册后结束当前轮次。它不睡眠、不轮询，也不等待任务完成。取消等待仅取消观察。报告保留三个必填字段，不声称运行时空闲或已关闭。

<a id="model-experience"></a>
## 模型体验

### 可选工具 schema

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#panedeskdsh-tool-seat)拥有完整 schema 与描述。可用性取决于提供方是否存在；不另行贡献系统提示词。

#### Token 影响

已安装工具 schema 仅在其提供方组可用时增加请求 token。

#### KV Cache 影响

稳定的已安装 schema 集合保留重复 schema 前缀。增加或移除提供方会改变集合，可能阻止前缀复用。

### 结构化工具结果

#### 模型看到什么

工具以 JSON 文本返回提供方结果，包括已提交操作标识、拒绝、忙碌原因、状态版本，以及适用时的有界目录内容。

#### Token 影响

结果按返回字段与内容上限增加会话 token。等待注册立即返回，而不消耗重复轮询轮次。

#### KV Cache 影响

已记录结果仅追加增长；本包不替换先前模型消息，也不独立刷新缓存。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 工具不实现提供方，也不绕过权限、文件系统准入或预算检查。
- 成功报告不能证明全部运行时工作已结算；关闭准入仍归提供方所有。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

重试中保持稳定调用归因，并在结束轮次前保留非阻塞等待结果。

</details>
