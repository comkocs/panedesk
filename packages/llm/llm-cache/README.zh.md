---
description: "会话缓存策略、维护与模型家族并发控制。"
kind: "package-reference"
---

# @panedesk/dsh-llm-cache

[English](README.md) | 中文

## 概述

会话缓存策略、维护与模型家族并发控制。此可选插件提供 `llmCache`，用于策略更新、证据查询与显式续租。保活默认禁用。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

`renewOnce` 在空闲维护点执行一次显式请求、带操作标识的保活，记录账本用量而不添加对话正文。证据缺失、缓存过期、前缀改变或维护冲突都可拒绝续租；执行不确定不能报告为续租成功。

调用计量属于完整 `sessionLedger`，不属于本插件。缓存策略与稳定前缀准备在请求冻结前执行；实例级调用贡献者为账本持有的调用提供缓存证据与模型家族准入。两种插件加载顺序都只记录一次调用。缺账本时请求原样透传；缺本插件时完整账本仍记录调用。贡献注册随插件释放，已准备贡献则保留至调用结算完成。

子会话继承父级原始保留期选择，除非其自身 `cachePolicy` 覆盖。解析使用子通路声明的能力：不支持的继承选择回退到 `default`，每个子 Session 至多警告一次，注明父级选择、子通路和实际保留期。子会话的显式选择仍严格校验。账本缓存控制与 TTL 描述子请求实际取用值；`sessionPolicy` 保留供后续继承与恢复使用的选择。

从包入口导入公共类型。本包仅用于 Host，不提供浏览器入口。

运行期间插入收件仍沿用 `interjection` 缓存断点。`interjection` 中止令被打断调用以 `cancelled` 结束，细因写 `upstreamStopReason: 'interjection'`，保留部分响应片段，并在被打断调用与后续调用记断点。普通用户取消保持独立。上游请求开头重组不被抑制：已提交的历史替换沿用 `history-edit`，请求头改变沿用 `request-config-change`；每次调用记录真实开头指纹。

<a id="model-experience"></a>
## 模型体验

### 缓存维护

#### 模型可见内容

`renewOnce` 可复用空闲 Session 的请求前缀发起维护调用，但不把其输出加入对话。插件不贡献面向用户的工具。

#### Token 影响

获准维护消耗提供方输入与有界输出 token，并记录到账本。证据查询不发起模型调用。

#### KV Cache 影响

续租可以刷新受支持提供方的缓存证据；过期或改变的前缀不会被静默当作可复用。普通前缀重组与中断断点保持启用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 续租需要存活空闲会话的证据及受支持的提供方路由。不确定的已尝试调用不会在同一操作标识下作为新续租重放。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
