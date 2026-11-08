---
description: "只读的「技能」设置分区：内置、用户级与项目级技能及其来源路径。"
kind: "package-reference"
---

# @panedesk/dsh-client-ui-skills

[English](README.md) | 中文

## 概述

使用**技能**设置分区查看本部署可用的技能。技能列表只读；全局文件系统提供方扫描控件通过现有 profile 配置编辑器保存。每一行显示技能名称、说明和来源路径，**打开源文件**把该路径交给宿主已有的文件打开动作。

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

在设置里打开**技能**，可选一个已注册工作区，再选择**加载技能**。内置技能和用户技能不需要工作区或会话。同名技能只显示实际生效的最高优先级来源，规则见[文件系统目录](../../skill/skill-filesystem/README.zh.md)。选择工作区会重新加载其项目根目录，无需打开项目会话；适用范围是全局加所选项目。每个扫描根目录（包含 Claude Code、自定义及已配置的 bundled 目录）都显示完整路径、是否存在、去重前的有效技能数和**打开目录**动作。来源文件行另有**打开所在目录**。宿主解析已注册 ID，不接受任意目录。

全局提供方控件显示完整 profile patch 路径，并提供打开文件和所在目录的动作。启用、默认目录扫描及监听均缺省开启，轮询缺省 100 毫秒。开关立即保存，轮询和每行一个的自定义目录输入框在失焦时保存。扫描关闭后仍可操作控件；未提供 profile 编辑器的部署会明确显示不可配置提示。这些控件适用于每个项目，而非仅当前所选工作区。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器半侧注册一个名为 `skills` 的 `settings.section`。列表调用 `skills.catalog`，传入所选工作区 ID 或 `undefined`；宿主汇总提供方拥有的目录检查数据。保存调用 `skills.configure`，通过 `configEditor` 及正常 Loader 协调流程编辑指定文件系统提供方配置。打开或显示路径调用 `session.openWorkspacePath`。宿主半侧是一个空的 `apply`，只为让本包占一条 Loader 行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-settings](../ui-settings/README.zh.md) — 声明 `settings.section` 的域基座。
- [skill-filesystem](../../skill/skill-filesystem/README.zh.md) — 目录读取所在的包。

-----

<a id="model-experience"></a>
## 模型体验

无。本包是浏览器侧设置界面，不注册模型界面。

#### KV Cache effect

无。本包既不组装也不发送提供商请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **手动刷新** — 列表按需读取，不监听文件变化；修改技能文件后需重新加载此分区。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
