# 席位编排

[English](seat.md) | 中文

本页拥有[席位包组](../../packages/seat/README.zh.md)声明的类型与服务语义。提供方和消费方保持可选；显式组合归[应用组合包](../../packages/seat/seat-app/README.zh.md)所有。

## 身份与权限

`SeatName` 标识节点本地定义；`SeatOperationId` 标识调用方保留的操作。会话身份仍采用上游 `SessionId`。`SeatCallContext` 包含可信适配器提供的已认证主体、来源与节点身份，不能将请求字段当作权限。`SeatBinding` 是会话日志旁的引擎元数据，区分自由与席位两种变体。

## 定义与准入

`SeatDefinition` 冻结其版本、启动及附加目录、开场文本、模型与权限选择、订阅、检查点文件、规则和本地容量。导入预览保留来源及映射摘要；提交所选行时同时检查原始来源和目录版本。来源权限仅通过获授权操作改变。

`SeatProjectPolicy` 在显式选择前默认为提醒模式。规则不能放宽项目策略。`SeatQueued` 报告 FIFO 标识与阻塞原因，不声称已取得资源。`ChildAdmissionTicket` 表示非阻塞子任务准入；取消未启动票据不终止运行中的子任务。`SeatTurnAdmission` 仅推迟新轮次，保留排队输入。

## 窗口操作

`OpenSeatResult` 区分已打开、已预填、既有窗口选择、已切换、已取消、排队及拒绝结果。创建不意味着首轮完成。`ReplaceSeatResult` 保留新旧身份与清理状态；替换先开新窗再关旧窗，并保留显式交接许可。`CloseSeatResult` 区分已关闭、忙碌、版本冲突和拒绝。未知活动不能作为空闲证据。

`SeatWindowView` 投影运行时状态、忙碌原因、缓存证据和状态版本。`SeatContextUsage` 表示带时间的当前上下文证据，不是累计计费 token。证据缺失保持未知。`SeatFailure` 携带机器码、说明、替代方案、可重试性及观察到的副作用状态。

## 引擎记录与查询

`EngineDecision` 在写入所有权与预期序列比较下提交一个含类型化 `EngineEffect` 记录的有界帧。引擎日志独立于会话、计费与消息日志。回调通过稳定标识与发件箱提供至少一次交付；恢复不重放结果不确定的模型副作用。

`EngineCursor` 按节点、序列和副作用索引排他推进。查询时间范围左闭右开；结果公开完整性与已提交水位。导出默认脱敏，除非另获独立授权。验证不执行导入操作。`SeatBudgetSnapshot` 保留未知成本，不将其视为零；`MicroUsd` 使用十进制整数微美元。

## 等待、报告与策略

`SeatWait` 对明确的 subagent、后台任务、调度或消息对象注册任一或全部观察，在完成前返回。取消只影响观察。`CloseSelfReport` 记录关闭意向、未完工作及下次开窗前置条件，不改变运行时状态。

`GateDefinition` 选择已安装判定器、钩子、版本、排序与到期条件。`GateContext` 包含执行器拥有的事实；`GateResult` 保留允许、拒绝或不适用结果与审计状态。`SeatWorktreeHost` 拥有版本校验持久化与强制授权；`SeatReminderHost` 拥有子任务阈值交付。操作字符串和模型文本均不提供授权。

## Cordis API

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->
<!-- END GENERATED cordis-surface -->
