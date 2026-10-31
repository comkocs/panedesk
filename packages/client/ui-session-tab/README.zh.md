---
description: "从会话行在右栏打开的会话页，以及保存在浏览器里、不改变模型所见内容的逐条钉住。"
kind: "package-reference"
---

# @panedesk/dsh-client-ui-session-tab

[English](README.md) | 中文

## 概述

本包给右栏加一种会话页，并在每条已完成的助手回复上加钉住。会话页从会话行的菜单打开，在钉住列表旁渲染该会话的消息与输入区；选中钉住只滚动这一处右栏会话。钉住是保存在浏览器里的书签。它跨重启保留，并且不改变模型所见的内容。右栏共用的可见会话预算为主区预留一席，并允许旁边显示两个会话页或子代理页。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步了解](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与 `ui-workspace`、`ui-sidebar-right`、`ui-conversation` 一起挂载。会话行的菜单多出「在右栏打开」。该页类型不在引导页上，因此不会出现在开始会话之前。钉住位于已完成助手回复的动作行。会话页列出该会话的钉住条目，必要时先载入更早历史，再定位选中的消息。

### 失败

拟提交布局超出共用的可见会话预算时，菜单会说明原因。不能保存存储的浏览器会说明钉住无法保存。无效资源地址和同步保留异常会收敛为可见的打开失败。钉住跳转显示加载状态，历史耗尽或没有进展时停止，无法定位消息时允许重试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本包以 `multiple: true`、且不进引导页的方式注册 `session` 页类型，向 `sidebar.workspaces.session.menu.item` 贡献 `open-in-right`（顺序 500），并向 `conversation.chat.assistant-actions` 贡献 `pin`（顺序 20）。钉住是 `dsh.session-pins.v1` 下一个文档：`{ schemaVersion: 1, pins: [{ sessionId, messageId, pinnedAt }] }`。`sessiontab` 资源通过 `sessions.retain` 保留目标，等待打开后提供 `SessionProvider`，并在资源关闭时释放。共享 `conversation.content` 工厂渲染消息与输入区。跳转只在本页查找 `data-message-id`，调用已保留会话的 `loadOlder()`，直到动作行出现或分页停止。Chat 首条锚点用于判断进展，不改变钉住格式；离开当前正文或选择另一枚钉住会取消后续分页与滚动，但不取消共享的在途历史请求。钉住写入成功后通过框架绑定的可观察源发布；不支持的文档版本不会被覆盖。打开时空间允许则优先新建停靠窗格，并使用右栏最终布局预算。嵌入输入区阶段区分等待首回合与已尝试发送，遵循共享会话生命周期。

</details>

-----

<a id="further-exploration"></a>
## 进一步了解

- [ui-sidebar-right](../ui-sidebar-right/README.zh.md) — 页签注册表与两个窗格的预算。
- [ui-workspace](../ui-workspace/README.zh.md) — 会话行菜单。
- [ui-conversation](../ui-conversation/README.zh.md) — 助手动作行。
- [客户端包图](../README.zh.md) — 相邻的浏览器界面包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为会话页和浏览器本地书签不增加模型可见内容或会话事件。

#### KV Cache 影响

无。打开会话页以及存下或去掉一枚钉住，都不改变模型可见的历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前会话页。它们是当前包约束，不是待办。

- **钉住需要已完成回合的动作行**——历史会自动分页，但已删除或无法渲染的消息无法定位。其他历史请求正在加载时，跳转会提示重试，不并发启动竞争分页。
- **钉住留在这个浏览器**——文档是本地存储。另一个浏览器，或被清空的存储，没有它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
