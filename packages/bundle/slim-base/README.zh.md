---
description: "Panedesk slim 预设的最小核心 bundle。"
kind: "package-bundle"
---

# @panedesk/slim-base

[English](README.md) | 中文

## 概述

`@panedesk/slim-base` 是 `@panedesk/dsh-base` 的逐行子集，提供最小 headless 核心、上下文压缩、大输出溢写、工具调用超时保护和 `AGENTS.md` 加载。它面向默认 slim 预设的用户，随 `panedesk` 启动器一同安装，作为核心 bundle 使用。它提供 profile 组合，而非独立命令；`panedesk "task"` 选择 slim，并配合 `@panedesk/slim-headless` 一次性任务 bundle。

沙盒模式由共享的[策略解析器](../../sandbox/sandbox-policy/README.zh.md)决定，包括 Windows 只读缺省值；本组合包不插入可写后备值。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="model-experience"></a>
## 模型体验

### slim 核心组合

#### 模型看到什么

本包通过 `cordis.patch.yml` 配置行组合核心插件，包括系统提示、工具、上下文压缩与工具结果裁剪。实际可见上下文由这些插件的配置和当前会话决定；本包没有独立的模型请求。

#### Token 影响

本包没有固定的独立 token 开销；组合的提示词和工具产生请求 token，压缩与裁剪可替换已保留的上下文。

#### KV Cache 影响

本组合包保留消息专用账本入口，并在同一个 harness home 中加挂完整调用账本与缓存层。缓存缺省冻结首次系统提示与工具前缀，并请求 Anthropic 1h 或 DeepSeek automatic 缓存。`retention: none` 禁用缓存控制，但不关闭前缀冻结。压缩或裁剪后的历史可能替换请求 token，使受影响的前缀无法复用。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 这个 bundle 只是完整组合的子集；slim 不随附模型路由，用户必须先配置提供商 overlay，才能运行任务。

<a id="dev-note"></a>
### 开发备注

`cordis.patch.yml` 由 `scripts/panedesk/gen-slim-base.ts` 从上游 base 配置生成；修改来源后重新生成，不手改生成的配置。
