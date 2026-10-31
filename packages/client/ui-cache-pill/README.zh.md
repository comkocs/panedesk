---
description: "输入区缓存药丸：主窗口与子代理的缓存剩余时间，以及只在显式通路上、于下一次请求生效的档位开关。"
kind: "package-reference"
---

# @panedesk/dsh-client-ui-cache-pill

[English](README.md) | 中文

## 概述

本包在已有的活动与用量药丸之后加一枚输入区药丸。点开后列出主窗口和每个有账本证据且有权限的后代子代理的缓存剩余时间。显式缓存通路同时给出该通路支持的档；自动通路只列出命中，不给开关。存下的档由该窗口的下一次请求携带。没有缓存证据的窗口显示未知，而不是编一个时长。

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

与 `ui-conversation` 一起挂载。药丸出现在已打开会话的输入区，不出现在开始会话之前的画面。收起时显示主窗口的读数。展开的面板位于整个输入区上方，不遮挡输入卡或工具行，并列出主窗口和每个有账本证据且有权限的后代子代理。只有显式通路显示档位按钮，并且只显示该通路支持的档。选定一档即存下；该窗口随后的请求携带它。

### 失败

读取失败、没有记录、以及部署没有缓存账本，各显示自己的一行。通路不支持的档在存下之前被拒绝，面板说明切换失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本包贡献 `conversation.composer.dock` 的 `cache` 项（顺序 2）。浏览器调用缓存包拥有的远程 `cacheView.read` 与 `cacheView.setTier`。这两个方法读取 `llmCache.remaining`、`llmCache.routeFor` 与 `llmCache.policy`，并通过 `llmCache.update` 存下一档。该窗口下一次 `agent/request` 把存下的策略写入请求。剩余秒数是账本估算值四舍五入到整秒。后代来自账本父会话标识，并逐项按调用者权限过滤。共享会话资源每四秒刷新证据；组件按完整秒数在本地递减读数。

</details>

-----

<a id="further-exploration"></a>
## 进一步了解

- [dsh-llm-cache](../../llm/llm-cache/README.zh.md) — 策略表、剩余时间估算，以及携带存下档位的请求。
- [ui-conversation](../ui-conversation/README.zh.md) — 声明输入区停靠位。
- [客户端包图](../README.zh.md) — 相邻的浏览器界面包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为药丸只读取缓存证据和存下下一次请求的缓存策略，不增加模型可见内容。

#### KV Cache 影响

无。显示剩余时间与存下一档不改变模型可见的历史。存下的档只改变之后某次请求的缓存控制。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前药丸。它们是当前包约束，不是待办。

- **剩余时间是估算**——没有证据的窗口显示未知。药丸不编造时长，显示的秒数与账本最多相差四舍五入的一秒。
- **后代由账本发现**——没有账本父子关联的子代理无法枚举。不完整快照明确标为部分记录，不声称后代列表完整。
- **开关等到下一次请求**——存下一档并不发出请求，已经在途的请求仍用发出时的档。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
