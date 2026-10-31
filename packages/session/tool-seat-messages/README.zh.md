---
description: "显式启用的单个位消息与本地在线观测。"
kind: "package-reference"
---

# @panedesk/dsh-tool-seat-messages

[English](README.md) | 中文

## 概述

向一个本地在开位发送消息，或查询在线位窗口。此可选插件使用[本地消息投递](../message-delivery-local/README.zh.md)与[位观测](../../seat/seat-local/README.zh.md)；不会开位或群发。

## 目录

- [使用本包](#use-this-package)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## 使用本包

将 `@panedesk/dsh-tool-seat-messages` 与 `tools`、`agents`、`messageDelivery` 和 `seatLocalRead` 一同挂载。在本地消息提供方显式设置 `seatAddressing: true`。安装完整依赖载体不会挂载工具，也不会改变既有投递缺省值。

存活的调用会话提供发件身份：绑定的位署位名；未绑定位的会话署标题并标记 `Free window`。模型参数不能选择发件人。发送采用持久 `handoff` 与 `steer` 优先级：忙碌收件方在下一工具步骤边界接收输入，空闲收件方在其交接唤醒策略允许时启动回合。既有收件策略与旧 queue 时序保持不变。

精确本地位名选择唯一当前主窗。未开位返回 `seat not open`；歧义选择返回原因与候选会话。在线观测包含位、会话、节点、忙闲状态与主窗选择。存活性未知时失败，不报告为空闲。

<a id="dev-note"></a>

## 开发备注

工具注册随插件作用域释放。不需要改变会话或消息账本格式。

<a id="model-experience"></a>

## 模型体验

### 单个位工具

#### 模型看到什么

`seat_send` 接受 `seat`、`text` 与可选 `node`；`seat_list_online` 无参数。结果是渲染为文本的 JSON，通用工具卡展示参数与结果。带署名的消息正文进入收件方持久用户消息历史。投递与读到使用既有消息账本。

#### Token 影响

工具 schema（模式）、调用结果与投递正文消耗 Token。在线查询不会启动收件方回合。

#### KV Cache 影响

工具可用性改变模式上下文。投递追加历史，不重写先前模型可见消息。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与后续工作

- 可选 `node` 选择一个已配置的远端节点身份；省略时保留本地寻址。远端发送与观测要求显式委托权限及兼容的 node-link 提供方。不提供通配与群发。远端拒因原样保留 `target-not-found`、`offline`、`busy-not-accepting`，并附中英说明。`seat_list_online` 将失联节点显示为 `status: 'unknown'`，而非成功的空快照。
- 在线状态是观测而非预留：收件方可能在解析与持久发送之间关闭。如果发送时观察到关闭且收件方仍有持久会话元数据，既有信箱保留排队邮件并返回 `target-closed-pending` 与 `pending: true`；这不代表投递或读到，工具不会重新打开收件方。空会话若在没有持久元数据时关闭，则可能返回 `target-not-found`，不排队邮件。接纳与读到仅由收件方后续消息账本回执报告。
- 重复工具调用使用相同操作身份；目标或署名变化可能被拒为操作冲突，而非重复发送。
- 收件策略可能拒收消息或禁止闲态唤醒。
