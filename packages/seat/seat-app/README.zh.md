---
description: "显式席位 CLI 配置方案与按需启用的提供方组合。"
kind: "package-bundle"
---

# @panedesk/dsh-seat-app

[English](README.md) | 中文

## 概述

通过共享启动器与[席位服务](../../../docs/subsystems/seat.zh.md)运行一条席位命令。选择 `panedesk --profile seat`；安装组合包不改变默认配置方案，也不安装后台服务。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

配置方案按顺序叠加基础组合包与本包。补丁声明账本、调度器、席位提供方、策略、工具、Remote 适配器和命令消费方。调度器的 Session 控制器使用仅宿主侧的工作区、上传和传输无关连接服务；不挂载 Web 服务器或浏览器应用。引擎行保持禁用，直到显式覆盖层以完整部署策略启用；不提供私有限制或自动开窗策略。Webhook 入口不配置，命令应用禁用配置监听。

命令默认 `list`。手动 `open` 默认 `prefill`；自动开窗需要明确选择。批次须明确列出每个席位。结构化操作接受 `--request` JSON，不能与字段选项混用；修改操作调用方可保留 `--operation` 标识。非法输入、提供方不可用及操作被拒返回状态码 2；成功返回 0。stdout 输出 JSON 结果。

命令等待 `appReady`。dispose（资源释放）移除就绪监听并排空正在执行的命令。本包不拥有引擎日志，也不绕过提供方就绪条件。

<a id="model-experience"></a>
## 模型体验

### 命令结果

#### 模型看到什么

CLI（命令行界面）输出不是模型上下文。`prefill`（预填）返回草稿而不启动模型轮次；明确请求的操作所交付内容归提供方所有。

#### Token 影响

解析与打印不增加模型 token。显式自动开窗、唤醒或续期可请求提供方拥有的模型工作。

#### KV Cache 影响

应用自身不重写模型前缀，也不刷新缓存。请求操作保留所选提供方的缓存行为。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 需要可用的本地提供方。没有引擎时，`nodeStatus` 返回配置身份、`engine: 'unavailable'`、零个引擎窗口以及空的上限和就绪时间；`list` 与引擎管理仍返回不可用。`import.preview` 与 `import.commit --request` 可在使用相同家目录的不同进程中通过保留的 `planId` 执行；源件或档案变化后须重新预览。
- 本组合包不安装操作系统服务，也不提供跨节点实时执行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

命令分发须保持在启动器就绪与提供方权限之后；不增加独立可执行入口或内联替代引擎。

</details>
