---
description: "与通道无关的一次性审批 seam；供组合应答者、设置策略或排查以拒绝方式关闭的权限决定的用户与维护者阅读。"
kind: "package-reference"
---

# @panedesk/dsh-user-approval

[English](README.md) | 中文

## 概述

要求敏感工具操作在继续前取得决定：`ask` 咨询人类或机器应答者，`never` 则直接拒绝，不发出提示。应答者缺失或失败时返回 `unavailable`，以拒绝方式关闭。普通审批只涵盖单次操作；工作区用途审批请求持久的 Windows 目录访问，由沙箱策略消费方保存。请求与结果进入会话审计日志。模型会看到工具结果与当前策略，不会看到人类权限 UI 或审计事件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当敏感工具操作应当暂停等待人或机器的决定、而非无条件执行时，组合此服务。工具流水线与沙箱 bash 工具会通过此 seam 路由 `ask` 决定，并在该 seam 缺失时以拒绝方式关闭，因此交互式部署至少应组合一个应答者。

### 组合应答者

普通应答者是 `approval/request` waterfall（瀑布式事件）监听器：返回结果为所负责的 agent（智能体）作答，或调用 `next()` 委托。限定到 agent 的监听器只接收该 agent 的请求；同级顺序不是策略优先级。工作区用途请求及 `ownerOnly: true` 的请求绕过 Host waterfall，经 Gateway 直接发往经过认证的 owner 答复流；没有这样的流时返回 `unavailable`，Host 监听器的返回值不能批准它。服务自身不提示人类。

### 设置策略

有效策略取会话中已设置的策略，并回退到配置的默认值。`ask`（默认）委托给已组合的应答者；`never` 在交互式分发之前确定性地拒绝每个请求——这是 CI 与无人值守运行采用的严格无头模式。

```yaml
- name: '@panedesk/dsh-user-approval'
  config:
    policy: ask
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `policy` | `ask` | 没有 `approval/policy` 覆盖的会话的默认策略 |
| `workspaceWriteTimeoutMs` | `60_000` | 工作区同意的最长等待时间；到期即取消请求 |

生成的[配置目录](../../../docs/config-catalog.zh.md#panedeskdsh-user-approval)是每个受支持字段及其 JSDoc 的穷尽式真源。`setPolicy(agent, policy)` 切换运行中的 agent 的策略，并为它的下一个模型步骤排队一条「由用户更改」消息；`setApprovalPolicy(session, policy)` 是会话初始化使用的直接持久写入路径。

### 请求决定

`request(req)` 指名 agent、工具、原因、可选的调用 id，以及一个中止信号。可选的 `purpose` 标识工作区同意并保留在审计事件中；其 `allowed-once` 结果表示同意该具名用途，不是通用的永久授权。可选的 `displayReason` 提供本地化展示文案，不改写日志中的原因。它要求当前处于尚未结束的轮次中：空闲或在轮次之间调用会在审计前抛出异常。中止会撤回问题——请求以 `cancelled` 结算，迟到的回答被丢弃。若任一审计事件在提交前失败，请求会被拒绝，而不会返回一项未记录的决定。

`requestProtectedInput(agent, purpose)` 在轮次之间接受路径及原版本和候选版本的摘要。它只使用经过认证的 owner 运输，并写入被动、持久的收件提示，不唤醒模型。`never` 保留输入被阻止的提示而不弹确认；其他结果追加决定提示。等待时间使用 `workspaceWriteTimeoutMs`；只有 `allowed-once` 确认该候选版本。对于已挂载的 profile，owner 运输就绪及新根 agent 会调度串行审核已保留的输入记录。有 HMR 时通过其事务应用已确认输入；没有 HMR 时，被动提示要求 owner 重启。直接重组拒绝也会调度同一审核，不阻塞等待弹窗。无人值守会话保留拒绝提示，始终不弹确认。新增 Client 分块及整包替换受同一精确候选版本决定约束；拒绝保留已发布的 Client 代次。

返回经过认证的工作区写入允许结果前，已挂载的 profile 会把已登记的受保护输入捕获到持久 owner 状态中。Windows 要求该状态位于可写根之外；Linux 和 macOS 也允许状态位于受保护的工作区第一级目录下。捕获失败时，请求结算为 `unavailable`，记录该结果，并在会话收件箱保留拒因，不授予写权。受保护输入确认独立于工作区授权，不会创建一般工作区写入授权。[工作区同意](../../sandbox/sandbox-policy/README.zh.md#windows-workspace-records)允许工作区普通位置写入，不允许受保护输入写入。

### 模型与用户看到什么

对于工具请求，模型会看到消费方最终给出的允许、拒绝、取消或不可用结果，以及当前策略；审计事件与面向人类的权限 UI 不属于模型上下文。受保护输入提示保留在收件箱，直到后续模型步骤消费。`never` 切换会以一条带来源的用户消息告知模型，两种策略都会把各自的完整当前含义贡献给快照。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

可观察行为已在[使用本包](#use-this-package)中说明；本节解释分发、策略执行与审计路径。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `ApprovalService`：请求分发、策略折叠与写入路径、运行时上下文贡献 |
| [`src/types.ts`](src/types.ts) | `ApprovalRequestId` brand 与结果类型 |

### 分发

`decide()` 让应答者 waterfall 与请求信号赛跑，并隔离所有应答者故障：抛出异常的监听器会使问题以 `unavailable` 关闭，不属于结果词汇的异常返回值也会规范化为 `unavailable`。`never` 策略在服务内部、waterfall 分发之前执行，因此之后以 `prepend` 注册的监听器也无法绕过确定性的拒绝。`request()` 必须处于未结束的轮次内，因为轮次是持久日志的提交／回放边界——轮次之间的裸事件与崩溃尾部无法区分。

### 策略与运行时上下文快照

系统提示词贡献 `approval:policy` 在保留历史之后陈述有效策略的完整当前含义——`ask` 及其以拒绝方式关闭的后果，或 `never` 及其非升权后果——因此切换策略会追加一份新的完整快照，而不会改写稳定的请求头。`setPolicy()` 还会注入一条带来源的用户消息，为下一步宣布变更。

### 审计

`request()` 先追加携带请求身份与工具的 `approval/asked`，再追加携带最终结果的 `approval/decided`；确切追加字段见 [`src/index.ts`](src/index.ts)。两者都只写入日志。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从审批词汇逐步进入消费方与设计依据。

- [审批子系统参考](../../../docs/subsystems/approval.zh.md)——共享的请求／结果词汇与 `ctx.approval` 的 Cordis 接口面。
- [审批 seam Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-approval-seam.zh.md)——该 seam 的设计依据。
- [沙箱 参考](../../shell/tool-bash/README.zh.md)——沙箱 bash 工具如何为升权重试消费审批。
- [交互组映射](../README.zh.md)——相邻的权限预设与问答包。

-----

<a id="model-experience"></a>
## 模型体验

### 当前审批策略上下文

#### 模型看到的内容

首次请求与有效策略每次变化时，都会在保留的历史后追加一份完整运行时上下文快照。在 `ask` 下，审批上下文内容会说明系统可以咨询已配置的应答者，缺少可用应答者时则以拒绝方式关闭。在 `never` 下，它会说明确定性的拒绝与非升权后果。未变化的请求会保留先前快照，不增加另一条消息。

##### Ask 策略贡献

```markdown
Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.
```

##### Never 策略贡献

```markdown
Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).
```

#### Token 影响

首次请求和策略实际变化时增加一条简洁的上下文消息；未变化的请求不增加重复的策略 token。

#### KV Cache 影响

在保留的历史之后仅追加。`ask`／`never` 切换会保留稳定的系统与对话前缀，而不会改写第一条 wire 消息。

### 工具结果

#### 模型看到的内容

`approval/asked` 和 `approval/decided` 只写入日志。模型只会看到发起请求的消费方最终给出的允许、拒绝、取消或不可用工具结果；面向人类的权限 UI 不属于上下文。

#### Token 影响

不会产生重复的审计 token。拒绝可能以一条简短且会保留的错误信息替换正常工具结果，而允许会保留消费方的普通结果。被动的受保护输入提示会在后续模型步骤消费收件箱时贡献文本。

#### KV Cache 影响

仅追加；新出现的可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该 seam 不适用的场景，以及组合时需要特别注意的场景。它们是当前包约束，不是通用权限对比。

- **`request()` 要求尚未结束的轮次**：在空闲时或轮次之间调用，会在审计前抛出异常。`requestProtectedInput()` 改用被动收件提示；这些提示不是持久的输入授权存储。
- **没有通用授权存储**：`allowed-once` 同意请求声明的用途；未声明用途时只涵盖单次操作。工作区持久化与撤销属于[沙箱策略消费方](../../sandbox/sandbox-policy/README.zh.md#windows-workspace-records)，不属于本服务。会话策略仍是 `ask`／`never`。
- **请求不携带工具参数**：应答者会看到工具名称、原因和可选调用 id；ACP（Agent Client Protocol）机器通道要求调用 id，并会委托不含 id 的请求。
- **没有内置应答者**：无头或组合不完整的部署会返回 `unavailable` 并以拒绝方式关闭；服务自身绝不会提示人类。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
