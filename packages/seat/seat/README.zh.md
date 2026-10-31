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

浏览器消费方通过纯类型 `@panedesk/dsh-seat/types` 子路径导入共享工位数据。其 Session 身份使用 `dsh-session/types`，调度选择器使用 `dsh-schedule/client`，使共享声明独立于 Host Session 服务。根入口仍暴露 Host 服务定义。

`SeatFailure.details` 可选通过 `agentPreset` 标识 Session 创建前被拒绝的预设，或通过 `provider` 与 `model` 标识不可用模型。`SeatNodeStatus.openingFailures` 独立于会话窗口投影尚未解决的前置条件失败；模型失败携带可选 `provider` 与 `model` 字段，引擎运行时失败仍位于 `failure`。其中可选 `unavailableOverTenMinutes: true` 标识连续不可用超过十分钟，恢复后随失败字段一起清除。可选 `stage: 'turn'` 标识活窗的 `UNKNOWN_MODEL` 或 `session/model-unavailable` 诊断，不改变开窗状态。可选 `SeatNodeStatus.callbackFailures` 独立于引擎故障，列出无效果且停车等待操作员处置的签发器拒权或回调认证拒绝。不带正文的 `seat/diagnostics-changed` 事件使已授权读取失效，不泄露诊断字段。[工位引擎](../seat-engine/README.zh.md)拥有投影及清除语义。

`EngineCloseData` 与 `window-ended` 回调可选保留细因 `approval-pending-cancelled`、`restart-manual-opening-closed` 或 `restart-source-wake-closed`，配合既有 `manual` 结束原因。两种重启细因也在收窗提交后投影到 `SeatNodeStatus.openingFailures`，保留本地化告警，不授权再次开窗。细因缺失时保持普通收窗语义；取消与停稳重核由[本地提供方](../seat-local/README.zh.md)负责。

可选 `SeatOpeningContexts.registerScopeAdmission` 为来源单项开窗及任务批次安装 `OpeningScopeAdmission` 所有者。所有者串行化评估、持久占位及既有执行器；注销排空在途调用。省略时保持既有评估器查询及拒绝行为。接口不含来源特有的工单字段。

可选开窗快照与触发引用保留提供方版本及任务证据，不改变旧开窗请求。`OpeningContextProvider.callback` 可选接收持久手动结果，附冻结引用及原操作身份；调用者不能提供回调目的地。本地提供方拥有路由与投递生命周期。`SeatGateService.evaluateTaskScopes` 是可选预检能力；任务批次调用者必须拒绝缺席的评估器，不能绕过。授权声明提供宿主拥有的签发注册、进程内凭证、原子动作事务与历史查询。可选 `validate` 在恢复外部工作前复核存活凭证，但不替代事务准入。`seatAuthorizedEngineActions` 为续期和换窗携带凭证；`seatAuthorizationExports` 提供独立版本化 JSON 分页，不扩宽旧效果。导入定义不安装任何提供方；`seat-engine` 提供持久化与查询。

`SeatCheckpointFile.mode` 可选 `section`（缺省）或 `file`。整文件模式忽略仍然必填的 `section` 字段，保留完整 UTF-8 文本，继续受 `maxBytes`、共享回灌预算与 `required` 约束；准入及校验由[门控提供方](../seat-gates/README.zh.md)负责。

提供方实现 `SeatService`、`SeatEngineService`、`SeatGateService` 与 `SeatDirectoryService`。消费方通过 `ctx.get` 获取可选服务；提供方缺席不构成操作授权，也不会激活替代实现。`withAuthority` 接收经过认证的服务端权限，不能直接使用请求中的身份声明。

待批队列元数据可选携带来自保留开窗证据的 `windowName`、`nodeId` 和 `budget`。缺失字段保持缺席；节点别名不是经过认证的节点标识，预算字符串以整数微美元计。旧消费方可忽略这些字段。

可选 `seatAuthorizationTransactions.operation` 返回 `SeatEngineOperationResult`：既有操作结果附加批准登记及关联进度元数据。它只读取已提交事实，不接纳动作；旧提供方可省略此能力。

`node-work-chain/v1` 声明原七方法及独立协商的 `seat.definitionRevision` 读、冻结来源输入、显式远开许可列表、运行模型证据与必需的 `node-route/accepted` 效果。可选 `openFrozen`、`wakeFrozen`、`acceptFrozen` 及来源准备、核验、回调挂点要求另装经过认证的提供方；省略不授予权限。`SeatFrozenOpen.nodeWorkChain` 为派发复核保留准入事实，`SeatBinding.staffBinding` 携带已核名册证据，`SeatCallbackDelivery.nodeWorkChain` 冻结完整远端回调。模型证据缺失时保持缺失，不从配置推断。原拒因经可选 `cause` 传递：code/domain 是最多 128 字节的受控 ASCII 标识，脱敏 reason 最多 512 个 UTF-8 字节。完整协商帧上限为 1,048,576 字节，并取两端与本地限额的最小值；超限拒绝而不截断。导入声明不启用路由、不改变旧载荷。持久化提供方必须在应用帧内任何部分前拒绝不支持的必需效果。

`SeatDefinitionRevisionRequest` 必须且仅有 `seat`、`sourceId`、`sourceOwnerNodeId`、`ownerEpoch`、`openingMethod` 和 `taskIds`。结果为 `SeatRejected` 或 `{ status: 'found', nodeId, seat, revision }`，revision 是逐定义的正安全整数。可选 `seatDefinitionRevisions` 提供 `ready`、`available` 和独立鉴权的 `read`；导入声明不授予读权或执行权。观察不属于业务方法或 `chain.operation` 查询对象，不能替换已经持久的冻结版本。

可选 `nodeWorkChainBusiness` 为六个业务方法注册 `NodeWorkChainBusinessProvider` 所有者，不包含 `chain.operation`。同一方法全局仅有一个提供方；方法重叠或重复注册均抛出异常，不能部分注册。通过 `ctx.get` 获取服务，缺席时跳过注册，保持基线行为。查询使用完整业务键和载荷摘要及已认证上下文，不以传输层待处理状态或旧操作号查询替代。各提供方的恢复屏障覆盖全部已持久意图与收件箱；屏障完成前只返回待处理或未知，不返回缺失，恢复失败不得通告接收能力。可选续推重新核验受限发件箱身份，保留原键与摘要，由提供方负责原子去重。本包仅提供声明；注册处与业务所有者由独立提供方实现。

可选 `SeatAuthorizationFact.sourceNodeId` 只出现在本地签发的 `node-delegation` 事实上：接收策略将传输层已认证的发送节点写入签发入口身份，绝不取自请求 JSON。旧事实与旧委托保持逐字节不变。可选 `SeatOpeningContexts.registerSourceOwner` 安装唯一受信 `SeatSourceOwner`，其必有的 `prepare`、`checkAdmission`、`deliverCallback` 方法与既有可选挂点签名一致。重复注册抛出异常；注销停止新调用并排空在途调用。未注册所有者时，提供方不暴露这三个方法；本包不安装实现。

仅宿主可用的 `SeatCallContext.localWake` 携带本机所有者唤醒所需的独立精确开窗凭证；`authorization` 携带原唤醒凭证。两者均为进程内签发器拥有的能力，不是 JSON 权限。本地提供方要求两者齐备，缺少任一个时均不回退旧准入。不新增授权种类或 wire 方法。

可选 `seatLocalCallbackOwner: SeatLocalCallbackOwner` 为来源所有者、目标及执行节点均为本地引擎的回调提供 `ready`、`available`、完整键 `query` 与冻结原包 `deliver`。每次查询或交付返回 `SeatCallbackAttemptResult<R>`，可附 `SeatCallbackDiagnostic`；提供方负责独立授权、持久去重、恢复及撤装。导入声明不安装提供方或默认注入，缺席绝不允许来源或对端兜底。`SeatCallbackDelivery.lastDiagnostic` 是可选的交付外层观察，不属于回调正文或业务摘要；旧记录省略该字段，成功交付只清除最新观察。失败阶段为 `retained`、`issuer`、`local-query`、`local-dispatch`、`peer-query`、`peer-dispatch`、`owner-inbox` 和 `writeback`；原因保留有界标识与脱敏说明。

可选 `OpenSeatRequest.startupDirectory` 为手动开窗选择精确的已登记目录；省略时保留档案起窗目录。本地提供方冻结所选起窗标记供执行与重放使用，不改档案，也不扩大目录授权；重试须保留相同选择。

可选 `SeatEngineService.wakeSource` 接收携任务上下文的已注册外部事件；方法缺席或返回 undefined 时保留普通触发入口。可选 `SeatEngineConfig.sourceWake` 选择来源与事件组合，`frozenWakeContext` 启用已有窗投递中的冻结任务正文。二者省略时均不启用；校验、授权与持久结果归 [seat-engine](../seat-engine/README.zh.md) 所有。不改变 wire 方法或已有必填字段。

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
