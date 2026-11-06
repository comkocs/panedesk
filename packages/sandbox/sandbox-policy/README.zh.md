---
description: "面向需要在各项负责强制执行的能力之间组合、配置或排查文件操作策略的用户与维护者，提供共享的逐调用沙箱策略解析器与当前模型上下文。"
kind: "package-reference"
---

# @panedesk/dsh-sandbox-policy

[English](README.md) | 中文

## 概述

使用本包可以让每次受限的 bash、文件系统和终端调用遵循同一份文件操作策略。部署方选择默认模式和回退工作区根目录，每个会话则可以独立切换模式。会话选择可跨重启保留，所有强制执行能力在一次调用中使用相同的模式和工作区。每次模型请求前，模型都会收到有效策略和工作区说明，但不会收到已挂载能力的清单。

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

在任何运行沙箱强制执行能力的组合中挂载此包：它拥有这些能力消费的部署默认值与逐会话覆盖，并把当前策略贡献给模型的运行时上下文快照。

### 何时选择

为每个带受限能力（bash、文件系统、终端）的组合选择它，让单一策略归属位置防止它们漂移到不同的模式或工作区根目录。只有没有任何沙箱策略强制执行时才跳过它——没有消费方时，解析出的策略不起作用。

### 最小配置

未显式配置模式或设置 `PANEDESK_PERMISSION_MODE` 时，Windows 缺省为 `read-only`，Linux/macOS 缺省为 `workspace-write`。显式部署配置与会话选择优先于平台缺省值。

```yaml
- name: '@panedesk/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: /absolute/path/to/workspace
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | Windows：`read-only`；Linux/macOS：`workspace-write` | 显式配置或 `PANEDESK_PERMISSION_MODE` 覆盖平台缺省值；加载时验证 |
| `workspaceRoot` | `process.cwd()` | 无 agent 调用或没有 cwd 的会话所用的绝对回退根目录；相对值在加载时拒绝。普通 agent 调用使用会话的不可变 cwd |

生成的[配置目录](../../../docs/config-catalog.zh.md#panedeskdsh-sandbox-policy)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 切换会话模式

会话的模式可以在运行时通过 UI 策略控件或显式切换来更改；切换记录在会话日志中，并在该会话的下一次受限调用时生效。切换通过回放跨重启保留，每个会话保持自己的模式——两个会话绝不会看到彼此状态。切换后的会话继续以不可变的工作区 cwd 作为写入边界。

<a id="windows-workspace-records"></a>
### Windows 工作区记录

Windows 有效授权及首次写入持久化要求通过受限令牌的[按位置区分的状态检查](../sandbox-windows-acl/README.zh.md#use-this-package)。原生检查失败时保留只读缺省值；写请求会报告失败。原生物化前还会在同意记录锁内复核。见[状态恢复及跨重启撤销](../../../docs/upgrade-guide/v0.2.1-rc.2/windows-workspace-write-access/guide.zh.md)。

Windows 中包含授权目录的工作区仍可启动只读会话，但首次写确认会被拒绝，并提示选择子目录。profile、状态位置及状态信任检查在任何 owner 提示之前执行，并在同意后再次执行。规则失败会把审批结算为 `rejected`，具体拒因同时保存在决定记录和持久会话收件箱中。Linux 和 macOS 中，宿主在授写前创建嵌套状态目录，并保护工作区根下通向其规范化位置的第一级目录；无关现存分支仍可写，但 Landlock 拒绝在工作区根下新建条目。所有者目录与状态目录共用 `dsh-sandbox` 的 `protectedWorkspaceBranches`，私密清单来自其 `ownerMaterialDirectories`。Windows 也拒绝覆盖私密存储的写入，但不阻止只读启动。工作区位于运行中的 profile 目录内时会被拒绝，并明确提示改选工作区。

在 Windows 隐式缺省模式下，产品 home 的 `windows-workspace-write` 目录中的有效授权记录会为对应规范化目录启用 `workspace-write`。记录包含目录、ISO 授权时刻及来源：设置页写入 `settings-preauthorization`，首次工作区写入审批获准后写入 `first-confirmation`。`requestWrite()` 仅在 Windows 隐式缺省、无记录且无显式会话模式时询问；允许后先保存同意，再物化原生授权。拒绝、取消、应答者不可用及审批期限到期均保持只读。`never` 不派发提示。记录授权在每次调用时解析，不保存为会话覆盖，因此撤销同样影响同意授权的会话。读写记录本身不修改 ACL。显式部署、会话和已批准调用模式仍优先。记录写者共用逐文件跨进程锁。撤销先持久化 `.revoking` 拒绝标记，再依次撤原生能力、删除记录和标记。撤销中断会阻止基于记录的写入及重新授权，直到重试完成；ACL 失败会保留清单记录以便重试。`pendingRevocations()` 校验并列出中断标记，即使没有授权记录也会列出。撤销已经不存在、且路径与记录完全相同的目录时，先核最近的现存祖先，再删除记录和标记，不调用原生 ACL。路径被替换为符号链接、非目录或不可访问时拒绝操作，并保留授权供恢复；此检查不防御并发文件系统替换。`withAuthorization()` 在基于记录物化原生 ACL 前立即持同一把锁重验同意，包括缓存策略；其回调不得对同一目录递归授权或撤销。锁不覆盖进程生命周期或后续文件操作；撤销不会终止正在运行的进程，也不会使已打开的句柄失效。这些记录描述本机 Windows 目录，不描述远端执行路径。

打开根已有有效写权限但无产品记录的工作区时，会把双语旧版写权限提示放入收件箱，引导所有者前往已有设置撤销列表。它既不创建同意记录，也不启动模型请求。检查故障保留双语提示，不阻断只读打开，也不声称发现了旧版权限。

`writeDenialHint(mode)` 为 Windows 隐式缺省下已经发生的只读拒绝提供双语只读原因与所有者预授权指引。文件和命令工具通过普通结果保留指引；其他平台、显式部署模式及更宽的已执行模式不返回替代提示。

直接授权与撤销按记录锁的取得顺序生效：直接授权在锁内读取当前代次，撤销在锁内推进代次。所有者重授在捕获前开始新代。捕获结果、原生物化与可写 argv 保留起始代次直到发布；旧代工作被拒绝。回滚在锁内复核原代次，不能撤销新授权。代次仅在进程内保存，不改变持久记录。可写 argv 一经发出，执行是否结束便缺少证明；立即重新授权会被拒绝，不把原生 ACL 撤销成功当作能力已排空。

<a id="protected-host-inputs"></a>
### 受保护的宿主输入

`resolve()` 从运行中的 profile、home patch 与授权记录、启动时读取的 bundle 清单与补丁、命令行叠加文件、已导入插件目录、Host HMR 根与活动的 `watchConfig()` 注册及 Client 产物目录收集 `protectedPaths`。它同时保留配置路径原名及规范化目标，避免采集时丢失符号链接原名。循环链接保留原名供后端检查保护覆盖；无法取得规范化目标不免除宿主校验，也不允许缺少保护覆盖的工作区授权。它不会在无关工作区内按文件形状寻找插件。受限文件系统写入拒绝重叠路径；本机进程提供方排除受保护输入，或拒绝包含它们的工作区授权。Windows 记录允许工作区包含保护输入，但拒绝工作区整体位于保护根内的授权；原生物化保留对输入的排除。`danger-full-access` 保留宿主用户的写权；插件管理仍单独要求 owner 同意。

保护在操作准入时检查。集合发生变化后，下一次调用不能复用已有 Node 内核或终端，但不会终止已在运行的进程，也不会使已打开的句柄失效。宿主路径是本机文件系统标识，不是远端 SSH 路径声明。

### 失败与恢复

无效的配置模式会在插件加载时被拒绝，因此拼写错误会导致显式报错，而不是静默改变策略。没有 cwd 的会话与无 agent 调用回退到配置的工作区根目录；带已批准显式模式的调用只在该次调用中使用该模式。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释策略解析、逐会话存储与模型可见贡献；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 解析优先级

`resolve({ session, mode })` 返回一份完整的逐调用策略：已批准的显式模式优先于会话最后一条 `sandbox/mode` 事件，后者又优先于有效部署默认值。仅 Windows 隐式缺省会在本机规范化后查询 home 级工作区授权，显式部署选择不会查询。会话的不可变 `cwd` 提供工作区根目录；否则使用配置的回退值。返回根目录保留执行环境中的路径写法，执行限制的提供方在自己的文件系统上规范化它。受支持的 SSH 组合要求两端均为 POSIX 主机，不查询 Windows 记录。

### 逐会话存储

运行时会话切换是在对应会话日志中追加的一条仅写入日志的 `sandbox/mode` 事件。`effective = approved call mode ?? fold(events) ?? authorized Windows workspace/default`，因此会话覆盖通过回放跨重启保留。会话覆盖彼此独立；home 级 Windows 工作区授权则有意在使用该目录的会话间共享。工作区标识无需事件：创建时记录的不可变 `SessionHeader.cwd` 是该会话每次调用使用的根。事件仍只进入日志；在每次请求前，归属方会把当前事实贡献给完整运行时上下文快照，agent loop（智能体循环）将该快照记录为一条带来源的 `user/message`。

### 模型可见文本

`sandbox:policy` 贡献说明该模式与具体能力无关的文件操作约定，以及 `workspace-write` 下已记录的会话工作区。它不枚举已挂载能力；工具插件保留特定于操作的拒绝与升权引导，批准策略单独贡献给同一份快照，计划引导仍由 `dsh-plan-mode` 的系统段落管理。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`SandboxPolicyService`、`Config` schema、策略解析与上下文贡献 |
| [`src/session-mode.ts`](src/session-mode.ts) | `sandbox/mode` 事件、其 fold 与写入路径 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

先从子系统参考文档了解共享词汇，再看 seam 约定与跨家族决策。

- [进程沙箱子系统](../../../docs/subsystems/sandbox.zh.md)——模式、逐调用策略与强制执行语义。
- [沙箱 seam 包](../sandbox/README.zh.md)——每个强制执行能力实现的隔离约定。
- [历史跨家族文件沙箱决策](../../../.agents/notes/archived/feature/2026-07-14-cross-family-fs-sandbox.md)——为何存在统一的共享策略归属位置。

-----

<a id="model-experience"></a>
## 模型体验

### 当前文件沙箱策略

#### 模型看到什么

每个 agent 会话的当前运行时上下文快照中都有一项 `sandbox:policy` 贡献。它不枚举已挂载的能力。工具插件继续负责操作与升权引导，批准策略单独贡献给同一份快照，计划引导仍由 `dsh-plan-mode` 的系统段落管理。

##### 只读

```markdown
Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.
```

##### 工作区写入

```markdown
Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: "<workspace root>". Some platform temporary areas may also be writable.
```

##### 完全访问

```markdown
Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.
```

#### Token 影响

首次请求和有效策略每次变化时增加一条简洁的持久上下文消息；未变化的请求不增加内容。`workspace-write` 只携带已记录的会话工作区路径；平台特定的临时路径会以摘要表述，不会加入依赖主机的字节。

#### KV Cache 影响

模式切换时，稳定的系统提示词仍逐字节相同。变化后的完整上下文快照会追加到保留的历史之后，从而保留此前已缓存的前缀；后续未变化的请求会复用该保留快照。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了本包提供的策略范围。它们是当前的包级约束，并非通用沙箱对比，也不是待办事项清单。

- **每个会话只有一个主要工作区根目录**——策略解析 `SessionHeader.cwd`；额外可写根目录不属于 `SandboxExecutionPolicy`。
- **仅限文件操作模式**——`SandboxMode` 管控文件操作；网络和进程策略不在其词汇中，因此这里没有限制它们的旋钮。
- **有意概述临时区域**——强制执行后端会授予不同的平台临时区域，这些区域在策略解析后才会选定，因此无法在当前上下文中如实枚举。

替换策略上下文时，必须使用先遭拒绝、再可申请升权的任务做反向验证，确认模型仍会尝试初次工具调用。[历史上十二轮中五轮没有工具调用的测量](../../../.agents/notes/archived/feature/2026-07-06-sandbox.md)记录了这项检查要防止的失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
