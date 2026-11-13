---
description: "面向模型的 subagent 委派工具，供用户与维护者配置、组合或排查基于 subagent 提供方的委派。"
kind: "package-reference"
---

# @panedesk/dsh-tool-subagent

[English](README.md) | 中文

## 概述

使用本包可为 agent 提供具名工具，把工作委派给配置的后端。获准的调用启动受管理的 activation 并返回子任务 id；排队调用则返回准入票据。运行时负责完成通知与清理。本地子任务支持消息和恢复，外部后端执行一次任务，并通过完成通知返回最终回答。受支持的后端可以公开获准的子级 LLM 路由。每个实例可选择子级 preset 和深度限制。

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

可选参数 `extra_tools` 列出无类型本地子代理额外需要的工具名，包括 `browser` 或 Chrome DevTools MCP 的精确名称；省略时使用缺省干活工具集，类型映射仍然有效。可选参数 `cwd` 选择子级的初始工作目录。相对路径以调用者当前目录解析；省略时继承该目录。调用者切换目录时，已有子级保留自己的目录。

每个委派目标挂载一个实例，且每个实例的 `toolName` 必须不同。工具与其提供方同时存在、同时消失，因此同级加载顺序与提供方重新加载都不会让工具悬空。无论配置名称是什么，每个实例均保留 `subagent` 执行能力，用于导入的 Claude Code `Agent` 限制，包括 `Agent(x, y)` 子级类型名单。

### 最小配置

先加载 subagent 服务、一个进程内或远程后端与本工具，然后指定提供方名称。此组合暴露一个委派给 `spawn` 后端的 `subagent` 工具：

```yaml
- name: '@panedesk/dsh-subagent'
- name: '@panedesk/dsh-subagent-spawn-in-process'
- name: '@panedesk/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | 必填 | `ctx.subagents` 上的提供方名称（如 `spawn`、`fork`、`acp`） |
| `toolName` | `subagent` | 面向模型的工具名称；每个已加载实例必须不同 |
| `modelSelectionSettings` | 忽略 | 保留兼容字段；每个 Session 都能选择已配置模型 |
| `agentOptions` | — | 配置的子级 `provider`、`model`、适配器所有的 `reasoningEffort` 与正整数 `maxTokens` 默认值；要求提供方支持 `agentOptions`，并会覆盖提供方持有的路由默认值 |
| `agentPreset` | — | 独立子级 preset 的默认 id；要求进程内 spawn |
| `allowedAgentPresets` | 忽略 | 保留兼容字段；`agent_preset` 提供所有可用注册预设 |
| `maxDepth` | Host 设置（`1`） | 绝对委派深度上限（`0` 禁止委派）；`'provider-managed'` 不向进程外提供方发送上限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#panedeskdsh-tool-subagent)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 受管理的委派

准入通过且运行时接受子任务后，调用返回 `started subagent <childId>`。排队调用则返回准入票据，不创建子级，也不等待空位。根超限票据包含排队位次，并提示调用者继续其他工作或关闭空闲子级释放容量；不带位次的提供方票据保留该提供方的等待指引。这两种结果均不等待子任务完成。activation 独立于已完成的工具调用拥有这项工作；运行时发送完成通知并释放执行资源。

所有后端的完成通知都会附带最终回答。本地 Spawn 和 Fork 子任务还可以发送消息，在活跃期间通过 `send_message` 接受更多工作，或在结束后恢复。Codex、Claude Code、ACP 与 DSH SDK 后端不接受后续消息。

`maxDepth` 限制递归深度（`0` 禁止委派）；省略时，每次委派读取 Host 当前的 `subagent.maxDepth` 设置，初始值为 `1`。数值深度要求提供方具备 `depthLimit` 能力；`'provider-managed'` 把预算留给进程外提供方。工具在达到上限时仍然可见；每次尝试启动都会检查调用 agent 的当前深度，被拒绝时返回出错的工具结果。

<a id="selecting-a-child-preset"></a>
### 选择子级 preset

设置 `agentPreset` 可指定独立子级预设默认值。可选参数 `agent_preset` 提供所有可用注册预设，包括导入的 `.claude/agents` 类型，不需要白名单开关。独立预设组合要求进程内 spawn；fork 与外部后端拒绝显式预设选择。

配置的默认值必须引用可用预设。Agent 初始化时读取预设描述，不依赖后端注册顺序；派遣时再次验证可选项。省略选择会使用配置的默认值或继承父级组合；显式选择挂载当前版本。导入类型的模型偏好在派遣时解析：`provider/model` 选择该精确路由；仅给模型名时按模型设置页顺序（已声明自定义路由优先，其他路由其次，官方 DeepSeek 最后）取第一家支持所要求推理档位、或未配置可选档位的路由。未配置档位的路由不带档位启动，其卡片显示 `档位不适用`；各家都能读到且都配置了档位、但都不含所要求档位时，取第一家并改用其最接近的受支持档位，启动结果附加 `effort lowered to <档位>`；只有每家的模型元数据都读不到时，调用才报错并列出每家提供商及跳过原因。裸模型名未命中时继承父级路由，启动结果报告实际 provider/model。显式 `model` 优先于导入偏好。

在 [preset 插件列表](../../preset/agent-preset-registry/README.zh.md)中配置 persona 与工具。包含 `persona` 或 `toolFilter` 的工具配置在加载时会报迁移错误。本地子级采用共享的 [preset 恢复规则](../subagent/README.zh.md#restoring-child-composition)。

### 选择子级 LLM

所有新建和恢复的 Session 都公开可选 `model`、`provider`、`reasoning_effort` 以及 `list_subagent_models`。可选字符串为空白与省略相同。工具说明要求调用方不要让子会话去调 `list_subagent_models` 或 `verification_checklist`，除非该工具在子会话自己的名单里。设置与历史 Session 策略均不控制选择能力。发现工具列出全部已配置提供方／模型路由，也可按提供方过滤或检查模型推理强度。没有 `agentOptions` 能力的后端在派遣时拒绝路由选择。

模型名在所有已注册提供方的 `llm.listModels` 中精确匹配。唯一命中时选择该提供方；多处命中时报告 provider/model 候选，无命中时报告可用模型。提供 `provider` 可消除歧义，只给提供方会失败。显式选择覆盖配置与提供方默认值；更换路由而未指定强度时清除路由相关推理默认值，其他省略值继承兼容的父级值。现有 LLM 适配器负责验证路由并按该提供方配置的协议发送。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具如何镜像提供方生命周期并结算运行；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

每个工具实例跟随后端注册生命周期。直接 Agent setup 立即安装；常驻预设组合在每个匹配 Agent 的作用域中安装并验证实时预设选项，不读取 Session 模型选择策略。已有可见发现工具时共享它。深度与配置的子级选项仍执行后端能力检查。

### Activation 所有权

工具调用 `ctx.subagents.startActivation()`，并选择向父任务交付。运行时拥有启动取消、执行、结果汇报与清理。启动失败产生出错的工具结果；发布后的失败通过完成通知到达，运行时保留诊断和部分输出。

### 结果确认

规范工具结果为 `{ kind: 'activation', subagentId }`。其中没有执行 Promise 或最终输出；需要等待结果的程序调用方直接使用 subagent 服务。

### 随上下文变化的措辞

精简后的工具描述源自 `provider.inheritsParentContext`：全新子 agent 使用独立上下文，fork 子 agent 看不到当前进行中的轮次。路由默认值与续聊支持仍明确说明；预设说明仅放在 `agent_preset` 参数，不再重复放进工具概述。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 工具注册、提供方生命周期镜像、activation 请求 |
| [`src/preset-selection.ts`](src/preset-selection.ts) | 配置的 preset 校验、模型白名单与描述引导 |
| [`src/model-selection.ts`](src/model-selection.ts) | 请求／配置合并与实时 LLM 路由预检 |
| [`src/model-selection-settings.ts`](src/model-selection-settings.ts) | 为现有部署配置保留的退役设置服务 |
| [`src/model-selection-state.ts`](src/model-selection-state.ts) | 为旧日志读取保留的历史策略投影，不再控制模型选择 |
| [`src/list-models.ts`](src/list-models.ts) | `list_subagent_models` 运行时发现工具 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从工具运行时行为进入它所委派其上的 seam，以及相邻的子 agent 工具。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——提供方、activation、结果与继续执行。
- [dsh-tool-subagent-control](../tool-subagent-control/README.zh.md)——可继续子 agent 的消息、中断与列表工具。
- [生成工具目录](../../../docs/tool-catalog.zh.md#panedeskdsh-tool-subagent)——默认 schema 与后端相关的措辞。
- [生成配置目录](../../../docs/config-catalog.zh.md#panedeskdsh-tool-subagent)——每个受支持配置字段。
- [历史模型选择 subagent 路由](../../../.agents/notes/archived/feature/2026-08-18-model-selected-subagent-routes.md)——选择策略、继承、发现与 fork 限制。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

新建和恢复的 Session 都始终公开 `agent_preset`、`model`、`provider` 与 `reasoning_effort`。注册表可用时提供可用预设 id 与描述。上下文继承与继续执行能力决定任务和后续消息说明；工具限制会移除 schema 及其指引。

#### Token 影响

每个父级请求的固定 schema 成本包含三个模型选择参数和一个预设参数及可用预设描述。每个工具实例增加一个 schema 和一段简短系统指引。

#### KV Cache 影响

只要提供方实例及其配置不变，前缀就保持稳定。适配器目录变化不会改变定义；子级路由覆盖可能使 fork 子 agent 无法复用继承的父级前缀。

### 模型选择与发现

#### 模型看到什么

`list_subagent_models` 列出全部实时配置目录。可选提供方／模型参数用于缩小发现范围或检查推理强度。显式模型选择要求唯一的已配置路由；不存在或有歧义的名称产生可操作错误。模型查询要求可选的 `ctx.llm` 服务已就绪。

#### Token 影响

可见委派组合共享一个发现 schema。只有请求目录时，其内容才进入 transcript。

#### KV Cache 影响

适配器注册与目录变化不会改变 schema 前缀。每个发现结果都追加在可复用前缀之后。

### 系统提示词

#### 模型看到什么

可见的委派工具共享一段指导，列出按名称排序的工具，指示模型一起启动相互独立的委派，并在它们运行时继续工作；当只剩等待它们的结果时，结束本轮，而不是休眠或轮询。隐藏或不可用的工具不列入其中；没有可见工具时，不输出指导。`subagent` 和 `subagent_fork` 都可见时，文本为：

##### 工具指导 section

```markdown
Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and continue useful work while they run.
```

#### Token 影响

每个父级请求最多包含一段简短的委派指导，列出该请求可见的工具名。

#### KV Cache 影响

可见工具名不变时，前缀保持稳定；增加或移除可见工具会更改这段指导。

### 运行时深度上下文

#### 模型看到什么

当调用方 agent 达到或超过某个可见工具实际生效的数值深度上限时，可选的运行时上下文快照会提示它直接完成工作。每次请求都会重新解析上限，包括 settings 变更或会话恢复之后。隐藏的工具和 `provider-managed` 上限不贡献深度文本。深度和上限都为一时，子 agent 看到：

##### 深度上限提示

```markdown
Delegation depth for `subagent`: current 1, maximum 1, remaining levels 0. Do not call `subagent` at this depth; carry out the work directly.
```

#### Token 影响

每个达到上限的工具向用户角色的运行时上下文快照贡献一小段文本。未变化的快照不会重复追加；未达到上限的 agent 不收到额外文本。`includeRuntimeContext: false` 会抑制这条提示，但不改变运行时对深度上限的强制执行。

#### KV Cache 影响

深度变化不改变系统提示词或工具 schema。更新的运行时上下文追加在已有历史之后；模型尝试委派时，提供方仍会强制执行上限。

### 启动结果

#### 模型看到什么

调用保留任务描述与提示词。本地子级首个请求确定实际路由后，启动返回 `started subagent <childId>; model <provider>/<model>`；启动拒绝返回错误。子任务执行详情单独交付。

#### Token 影响

提示词与确认保留在父级历史中，直到上下文压缩；子任务工作上下文留在子任务中。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 完成交付

#### 模型看到什么

回答投递遵循上文的受管理委派规则。返回的子任务 id 用于后续控制与目录操作；只有支持继续执行的后端才接受后续消息。

#### Token 影响

消息与完成通知独立于启动确认追加到父级历史。工具结果本身不包含最终输出。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本工具不返回或不强制执行什么；它们是当前包约束。

- **本工具不等待结果**——使用完成通知或子任务消息。程序化结果等待由 subagent 服务提供。
- **Fork 路由更改可能阻止前缀复用**——可以选择模型，但其他模型／提供方可能重新计算继承的对话。
- **后端能力仍然生效**——独立预设要求 spawn，模型覆盖要求 `agentOptions`。受控预设的显式运行时执行策略仍然强制执行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
