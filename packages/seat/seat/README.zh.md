---
description: "节点本地席位、引擎操作、策略与注册目录的服务定义。"
kind: "package-reference"
---

# @panedesk/dsh-seat

[English](README.md) | 中文

## 概述

定义席位服务及共享请求、结果、事件和策略类型。导入本包不会安装引擎、创建会话或注册工具。类型参考归[席位子系统](../../../docs/subsystems/seat.zh.md)所有。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

可选开窗快照与触发引用保留提供方版本及任务证据，不改变旧开窗请求。`SeatGateService.evaluateTaskScopes` 是可选预检能力；任务批次调用者必须拒绝缺席的评估器，不能绕过。授权事件仍为独立声明：这些增量未安装授权写入器、查询提供方或节点委托签发器。

提供方实现 `SeatService`、`SeatEngineService`、`SeatGateService` 与 `SeatDirectoryService`。消费方通过 `ctx.get` 获取可选服务；提供方缺席不构成操作授权，也不会激活替代实现。`withAuthority` 接收经过认证的服务端权限，不能直接使用请求中的身份声明。

稳定的操作标识、版本比较、显式不完整分页和类型化拒绝，使重试期间的结果保持可观测。引擎决策不属于会话事件联合。配置与执行归提供方所有；声明不提供部署默认值。

<a id="model-experience"></a>
## 模型体验

### 服务声明

#### 模型看到什么

`SeatService` 及其他声明不贡献工具、提示词文本或消息。

#### Token 影响

导入定义不增加请求 token，也不启动模型请求。

#### KV Cache 影响

本包不改变请求前缀，也不刷新提供方缓存。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 服务需要另外安装提供方；仅靠声明不能打开、续期、关闭或查询窗口。
- 实时操作限于本节点。节点标识不构成在其他节点执行的权限。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

提供方负责持久提交和等待完成的 dispose（资源释放）；消费方不能从缺失证据推断成功。

</details>
