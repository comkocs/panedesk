---
description: "图形化只读会话统计与配置管理。"
kind: "package-reference"
---

# @panedesk/dsh-client-ui-stats

[English](README.md) | 中文

## 概述

为[会话遥测子系统](../../../docs/subsystems/session-telemetry.zh.md)展示会话数、子代理、token 用量和已记录调用的时间轴。[账本查询服务](../../session/ledger-query/README.zh.md)负责聚合及缺失数据语义。

## 目录

- [配置与使用](#configuration-and-use)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration-and-use"></a>
## 配置与使用

Web 组合同时加载 Host 和 Client。`enabled` 默认 true，设为 false 时拒绝读取统计，但不停止记录会话。`refreshIntervalMs` 默认 10000，接受 1000 至 2147483647 的整数。两项都是可即时更新的配置字段，通过现成配置表单立即保存。读取不开放会话正文或模型操作。

紧凑图标注册在 `conversation.session.header.actions`，顺序为 30，点击直接打开图表弹层，minimal 预设也可使用。不另设主区面板、工具子菜单、首页或侧栏入口。关闭弹层会释放统计资源，卸载会移除所有注册。

设置 → Panedesk → 统计说明功能、默认启用状态、全局适用范围及刷新间隔。页面显示当前配置文件和本地账本目录的宿主绝对路径，并提供系统打开按钮。关闭统计后仍可读取 `stats.locations()`。未知存储提供者不显示猜测路径。本地账本读取各节点 `events` 和 `imports` 目录内的 JSONL 记录，统计功能不会修改它们。

图表共用一份固定时间范围快照。已有工作区成员关系、会话目录和父子关系用于关联项目，无法对应的会话保持未关联。项目及会话选择器同时筛选数字卡、模型 token 条形图和按北京时间分组的每日柱状图。关系区域以当前或选中会话为起点，显示有记录的子代理、模型、调用区间及实测调用用时。缺失数据保持未知；扫描不完整或刷新失败均明确提示。暂停保留快照，刷新可主动重试。

<a id="model-experience"></a>
## 模型体验

### 账本观测

#### 模型可见内容

统计不注册工具、提示或 Session 消息。配置变更只影响统计读取。

#### Token 影响

读取和刷新不发起模型请求，不消耗模型 token。

#### KV Cache 影响

插件不修改模型请求前缀，也不刷新缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 项目关联需要已有工作区或会话元数据，不把账本内部归属当作项目。
- 费用为参考估算，不是实付或订阅费用。缺价、token 或用时保持未知。
- 时间轴色条表示模型调用，不是子代理的完整生命周期。未完成调用延伸到快照观测时刻，但不宣称用时已知；没有调用记录的会话不画时间条。
- 筛选使用所选快照的全部调用明细，大范围可能开销较高；选择仅保留在当前弹层内，不提供导出流程。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

图表使用 React、CSS 和现成主题语义颜色，不依赖图表库，也不另建统计数据服务。

</details>
