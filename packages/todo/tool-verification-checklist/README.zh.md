---
description: "面向模型的 verification_checklist 工具：一句需求标题及其计划检查项，记在调用它的会话上。"
kind: "package-reference"
---

# @panedesk/dsh-tool-verification-checklist

[English](README.md) | 中文

## 概述

`dsh-tool-verification-checklist` 让 agent 在开工前记录一项需求计划做的检查。每次调用用一句话点明需求并列出检查项；没有要验证的内容时提交空列表。同一标题再次提交会替换该需求，其他需求保留。清单归调用它的会话所有，跨轮次保留。提交不等待批准。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂载本包不需要配置。工具名是 `verification_checklist`。一次调用带 `title`（一句需求标题）和 `items`，每项含 `category`（`write`、`read`、`build`、`test-focused`、`test-full`、`mutation`、`client`、`ci`、`script`、`wait`、`model`、`other` 之一）、`note`（一行说明）和 `minutes`（预计分钟）。同一标题替换它之前的清单。agent 会话之外的调用会被拒绝。

```yaml
- name: '@panedesk/dsh-tool-verification-checklist'
```

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到 `verification_checklist`：必填的 `title` 字符串和必填的 `items` 数组，元素为 `{ category, note, minutes }`。描述要求开工前提交清单，用同一标题再次提交以替换该需求，没有要验证的内容时提交空的 `items` 数组。

#### Token 影响

工具可见的每次请求都有固定的 schema 开销。

#### KV Cache 影响

定义与可见性不变时前缀稳定。

### 系统提示

#### 模型看到什么

验证策略行同时带这条指示。

```markdown
Before you start work, call verification_checklist with a one-sentence requirement title and the checks you plan to run. If there is nothing to verify, submit an empty items array.
```

#### Token 影响

既有策略行上多一句。

#### KV Cache 影响

这句话固定不变，不随轮次变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只有单一归属** — 清单归调用它的 agent 会话所有，非 agent 调用会被拒绝。
- **只能按标题整体替换** — 没有逐项编辑，也不能单独删掉一项需求而不重交清单。
- **不等待批准** — 提交记下清单后立即返回。

<a id="dev-note"></a>
## 开发说明

插件导出 `name`、`inject`、`apply`，没有默认导出。`inject` 只列 `tools` 与 `sessionProjections`，工具目录因此不需要活动或验证服务就能启动它。
