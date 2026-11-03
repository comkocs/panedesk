---
description: "Panedesk slim 预设的一次性任务 bundle。"
kind: "package-bundle"
---

# @panedesk/slim-headless

[English](README.md) | 中文

## 概述

`@panedesk/slim-headless` 在 `@panedesk/slim-base` 之上组合 `@panedesk/dsh-headless` 一次性任务执行器，并采用 Panedesk 默认配置。它随 `panedesk` 启动器一同安装，面向使用默认 slim 预设、每次运行一个任务的用户。它是 profile bundle，而不是独立可执行程序：通过 `panedesk "task"` 调用，使用 slim 核心和此执行器打印最终答案，然后退出。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="model-experience"></a>
## 模型体验

### 一次性任务组合

#### 模型看到什么

本包配置系统提示的 coding agent 人设，关闭 harness 身份行，并采用 headless 执行器提交用户任务。模型看到所选模型名对应的人设及任务；提供商和模型必须先通过 profile 或 overlay 配置。

##### 人设前缀

```markdown
You are a coding agent powered by the {{model}} model.
```

#### Token 影响

每次调用提交任务文本，且系统提示包含人设而不包含 harness 身份行；token 数随任务和已配置模型名变化。

#### KV Cache 影响

配置不变时人设前缀保持稳定。更改模型名、人设或工具模式可能改变前缀；用户任务追加在其后，提供商决定是否提供缓存及其有效期。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- slim 不随附模型路由；运行任务前必须配置提供商 overlay。执行器每次调用处理一个任务，不提供交互式后续会话。

<a id="dev-note"></a>
### 开发备注

`cordis.patch.yml` 在 slim 核心之后应用；本包不提供独立命令，且不得隐式选择默认模型路由。它透传 headless 执行器的[沙盒状态诊断](../headless/README.zh.md#use-this-package)，包括 `--sandbox-status zh --json`，不提交任务。
