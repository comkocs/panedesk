---
description: "节点本地席位、引擎操作、策略与注册目录的服务定义。"
kind: "package-reference"
---

# @panedesk/dsh-seat

[English](README.md) | 中文

## 概述

定义席位服务及共享请求、结果、事件和策略类型。导入本包不会安装引擎、创建会话或注册工具。类型参考归[席位子系统](../../../docs/subsystems/seat.zh.md)所有。

可选 `SeatService.messageWindows` 及对应的 `SeatLocalReadAccess` 能力提供已提交的本地窗口身份与主窗选择，用于消息路由。能力缺失不表示没有在开位。查询不开窗，也不修改引擎事实。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

可选 `SeatOpeningContexts.registerScopeAdmission` 为来源单项开窗及任务批次安装 `OpeningScopeAdmission` 所有者。所有者串行化评估、持久占位及既有执行器；注销排空在途调用。省略时保持既有评估器查询及拒绝行为。接口不含来源特有的工单字段。

可选开窗快照与触发引用保留提供方版本及任务证据，不改变旧开窗请求。`OpeningContextProvider.callback` 可选接收持久手动结果，附冻结引用及原操作身份；调用者不能提供回调目的地。本地提供方拥有路由与投递生命周期。`SeatGateService.evaluateTaskScopes` 是可选预检能力；任务批次调用者必须拒绝缺席的评估器，不能绕过。授权声明提供宿主拥有的签发注册、进程内凭证、原子动作事务与历史查询。可选 `validate` 在恢复外部工作前复核存活凭证，但不替代事务准入。`seatAuthorizedEngineActions` 为续期和换窗携带凭证；`seatAuthorizationExports` 提供独立版本化 JSON 分页，不扩宽旧效果。导入定义不安装任何提供方；`seat-engine` 提供持久化与查询。

提供方实现 `SeatService`、`SeatEngineService`、`SeatGateService` 与 `SeatDirectoryService`。消费方通过 `ctx.get` 获取可选服务；提供方缺席不构成操作授权，也不会激活替代实现。`withAuthority` 接收经过认证的服务端权限，不能直接使用请求中的身份声明。

可选 `seatAuthorizationTransactions.operation` 返回 `SeatEngineOperationResult`：既有操作结果附加批准登记及关联进度元数据。它只读取已提交事实，不接纳动作；旧提供方可省略此能力。

`node-work-chain/v1` 声明原七方法及独立协商的 `seat.definitionRevision` 读、冻结来源输入、显式远开许可列表、运行模型证据与必需的 `node-route/accepted` 效果。可选 `openFrozen`、`wakeFrozen`、`acceptFrozen` 及来源准备、核验、回调挂点要求另装经过认证的提供方；省略不授予权限。`SeatFrozenOpen.nodeWorkChain` 为派发复核保留准入事实，`SeatBinding.staffBinding` 携带已核名册证据，`SeatCallbackDelivery.nodeWorkChain` 冻结完整远端回调。模型证据缺失时保持缺失，不从配置推断。原拒因经可选 `cause` 传递：code/domain 是最多 128 字节的受控 ASCII 标识，脱敏 reason 最多 512 个 UTF-8 字节。完整协商帧上限为 1,048,576 字节，并取两端与本地限额的最小值；超限拒绝而不截断。导入声明不启用路由、不改变旧载荷。持久化提供方必须在应用帧内任何部分前拒绝不支持的必需效果。

`SeatDefinitionRevisionRequest` 必须且仅有 `seat`、`sourceId`、`sourceOwnerNodeId`、`ownerEpoch`、`openingMethod` 和 `taskIds`。结果为 `SeatRejected` 或 `{ status: 'found', nodeId, seat, revision }`，revision 是逐定义的正安全整数。可选 `seatDefinitionRevisions` 提供 `ready`、`available` 和独立鉴权的 `read`；导入声明不授予读权或执行权。观察不属于业务方法或 `chain.operation` 查询对象，不能替换已经持久的冻结版本。

可选 `nodeWorkChainBusiness` 为六个业务方法注册 `NodeWorkChainBusinessProvider` 所有者，不包含 `chain.operation`。同一方法全局仅有一个提供方；方法重叠或重复注册均抛出异常，不能部分注册。通过 `ctx.get` 获取服务，缺席时跳过注册，保持基线行为。查询使用完整业务键和载荷摘要及已认证上下文，不以传输层待处理状态或旧操作号查询替代。各提供方的恢复屏障覆盖全部已持久意图与收件箱；屏障完成前只返回待处理或未知，不返回缺失，恢复失败不得通告接收能力。可选续推重新核验受限发件箱身份，保留原键与摘要，由提供方负责原子去重。本包仅提供声明；注册处与业务所有者由独立提供方实现。

可选 `SeatAuthorizationFact.sourceNodeId` 只出现在本地签发的 `node-delegation` 事实上：接收策略将传输层已认证的发送节点写入签发入口身份，绝不取自请求 JSON。旧事实与旧委托保持逐字节不变。可选 `SeatOpeningContexts.registerSourceOwner` 安装唯一受信 `SeatSourceOwner`，其必有的 `prepare`、`checkAdmission`、`deliverCallback` 方法与既有可选挂点签名一致。重复注册抛出异常；注销停止新调用并排空在途调用。未注册所有者时，提供方不暴露这三个方法；本包不安装实现。

可选 `seatLocalCallbackOwner: SeatLocalCallbackOwner` 为来源所有者、目标及执行节点均为本地引擎的回调提供 `ready`、`available`、完整键 `query` 与冻结原包 `deliver`。每次查询或交付返回 `SeatCallbackAttemptResult<R>`，可附 `SeatCallbackDiagnostic`；提供方负责独立授权、持久去重、恢复及撤装。导入声明不安装提供方或默认注入，缺席绝不允许来源或对端兜底。`SeatCallbackDelivery.lastDiagnostic` 是可选的交付外层观察，不属于回调正文或业务摘要；旧记录省略该字段，成功交付只清除最新观察。失败阶段为 `retained`、`issuer`、`local-query`、`local-dispatch`、`peer-query`、`peer-dispatch`、`owner-inbox` 和 `writeback`；原因保留有界标识与脱敏说明。

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
