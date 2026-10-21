---
description: "Panedesk 启动器可选的完整预设承载包。"
kind: "package-reference"
---

# @panedesk/full

[English](README.md) | 中文

## 概述

`@panedesk/full` 承载上游 DSH 的 headless 组合、web/ACP/SDK 应用、可选 bundle 和插件管理器。需要默认 slim 预设之外这些能力的用户，将它安装在 `panedesk` 启动器旁，即可启用 `full`、`web`、`acp` 和 `sdk` profile。它补充启动器，而不提供独立命令；运行 `panedesk full` 选择完整 headless 预设。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="model-experience"></a>
## 模型体验

### 显式选择完整 profile

#### 模型看到什么

本包只承载依赖，不直接插入提示词或工具 schema。模型收到的上下文由显式选择的 `full` profile 所组合的插件提供；仅安装本包不会改变 `slim` 请求。

#### Token 影响

本包直接增加零个请求 token；显式选择其他 profile 后，token 用量由该 profile 挂载的插件决定。

#### KV Cache 影响

仅安装本包不替换请求前缀。切换 profile 会改变组合的提示词和工具，可能使已有前缀无法复用；提供商的缓存可用性由提供商决定。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 这个可选承载包必须安装在启动器旁；仅安装 slim 启动器不会使完整 profile 可用。

<a id="dev-note"></a>
### 开发备注

依赖清单是本承载包的发布内容；空的模块入口不提供运行时 API。修改依赖时须保留启动器按需解析完整 profile 的行为。
