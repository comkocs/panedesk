---
description: "供显式技能调用的便携工作模式包引导与目录资源。"
kind: "package-reference"
---

# 内置工作模式包

[English](README.md) | 中文

## 概述

提供方通过技能注册表提供工作模式包向导与资源。加载不会运行工具、启动模型或修改项目。

## 目录

- [使用本包](#use-this-package)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

这个[技能子系统](../../../docs/subsystems/skills.zh.md)提供方注册可由用户和模型调用的 `workflow-pack`。正文是便携的[开局向导](../../../templates/workflow-pack/getting-started.zh.md)，完整包作为目录资源提供。按需选三个入口之一：[核对产品需求](../../../templates/workflow-pack/requirements-review.zh.md)设计产品、开局向导搭建工作流，或[优化工作流](../../../templates/workflow-pack/workflow-checkup.zh.md)体检已有项目。写项目文件前先读对应向导；加载技能不会写文件或启动模型。

构建将 `templates/workflow-pack/` 复制到 `lib/workflow-pack/`，只维护模板源。桌面构建将该目录解包到 `app.asar.unpacked`；提供方将这个真实目录作为运行脚本命令和复制模板的资源基目录。不含 `app.asar` 路径段的开发态路径保持不变。绝对路径 `assetRoot` 可覆盖打包资源目录；资源不完整时插件激活失败。

<a id="dev-note"></a>
## 开发备注

发布资源清单位于 `package.json`；构建复制逻辑位于 `tsdown.config.ts`。

<a id="model-experience"></a>
## 模型体验

### 工作模式包引导

#### 模型看到的内容

发现技能只向目录增加 `workflow-pack` 描述。调用时技能消费者返回 `getting-started.md` 开局向导和目录资源指导，不自动注入 225 条规则表。

#### 令牌影响

本包不发起模型调用。目录描述和请求的向导经技能消费者消耗模型上下文；额外规则和工具只在读取时增加上下文。

#### KV 缓存影响

加载提供方不改写提示前缀。调用的技能正文保留在消费者的工具历史中；后续读取追加内容，不替换早先结果。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 裁剪工具为兼容保留中文需求卡键与生成文件名。运行需要 Python 3.11 或更新版本。
- 提供方提供资料和指导，不授予修改用户项目的权限。
