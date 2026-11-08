---
description: "插件页中的子智能体委派深度与并行容量设置。"
kind: "package-reference"
---

# @panedesk/dsh-client-ui-settings-subagent

[English](README.md) | 中文

## 概述

打开**插件**并选择**子智能体**，可配置委派深度和并行容量。模型选择始终使用已配置目录，没有权限开关或独立白名单。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

**运行限制**把**最大递归深度**和**子智能体并行数量上限**并排放置，窄屏时上下堆叠；每个标签旁的信息按钮展开它的规则——深度是一张两行示例表，容量是计数口径——填了不在范围内的整数会阻止保存并在字段下说明。深度让位于工具自己的上限；容量统计同一主 Agent 下所有层级存活的子智能体，主 Agent 不计入。



**保存**通过 `subagent` 命名空间写入限制，以草稿读取时的修订号约束写入。失败的写入保持可见供修正；离开页面会丢弃草稿。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 入口提供浏览器插件。`SubagentLimitsCardController` 通过 `ctx.configForms.get` 绑定 `subagent`，在共享 `SettingsFormModel` 中暂存限制。`SubagentCard` 渲染框架绑定的快照和保存／放弃操作。`ctx.configForms.whileServed` 仅在该命名空间被服务时注册插件页条目。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-plugin-manager](../ui-plugin-manager/README.zh.md)——插件页以及本页注册进去的 `plugins.item` slot。
- [ui-settings](../ui-settings/README.zh.md)——本页依赖的设置 scope 与"命名空间被服务期间"的监视。
- [ui-primitives](../ui-primitives/README.zh.md)——运行限制部分渲染的设置表单模型与字段。
- [tool-subagent](../../subagent/tool-subagent/README.zh.md)——委派与实时模型选择。

-----

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧的设置界面，不注册任何模型面。

#### KV 缓存影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 工具单独配置的深度上限优先于此处显示的 Host 默认值。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
