---
description: "右栏验证清单，按需求标题分组，并显示观察到的活动用时。"
kind: "package-reference"
---

# @panedesk/dsh-client-ui-verification-checklist

[English](README.md) | 中文

## 概述

从会话头部打开该会话的验证清单，显示在右栏页签。需求按代理提交的标题分组。每条检查项显示说明、预计分钟，以及该会话观察到的该类别实际用时。工作区已关闭的类别标灰并注明原因，取消勾选会把该类别追加到当前任务的禁止项。跑过但未申报的类别标为未申报，用时仍计入。子会话提交的清单汇总进父会话的面板。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

头部按钮打开 `dsh-resource://verificationchecklist/session/<sessionId>`，页签种类为 `verificationchecklist`。`minimal` 预设不显示该按钮。实际用时取自同一会话的子代理树资源。标灰读取工作区验证记录；没有记录时按产品默认，只把变异测试标灰。会话没有当前活动任务时，检查项不能关闭。策略读取与禁止项写入失败时显示服务原始错误。

-----

<a id="model-experience"></a>
## 模型体验

### 验证清单面板

#### 模型看到什么

没有。面板只向用户展示代理已经提交的清单。

#### Token 影响

无。

#### KV Cache 影响

无。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **关闭检查项是单向的** — 禁止项只追加，本面板不能移除。
- **用时依赖树资源** — 树还没加载的会话，其检查项的实际用时显示为未知。
- **子会话汇总用父会话的树** — 父会话的树没有报出的子会话，在父面板里用时为未知；它自己的监测详情仍会显示。

<a id="dev-note"></a>
## 开发说明

宿主入口导出空的 `apply`；浏览器半边在 `./client`。功能包之间不做运行时导入：清单与验证资源的类型通过仅类型导入到达。
