---
description: "通过声明式 preset 选择 Agent 的工具、提示词和技能。同一进程可以运行多种组合。配置失败会显示在列表中；现有 Agent 保留已经使用的组合。"
kind: "package-reference"
---

# @panedesk/dsh-agent-preset-registry

[English](README.md) | 中文

## 概述

通过声明式 preset 选择 Agent 的工具、提示词和技能。同一进程可以运行多种组合。配置失败会显示在列表中；现有 Agent 保留已经使用的组合。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

### 最小配置

```yaml
- id: agent-preset-registry
  name: '@panedesk/dsh-agent-preset-registry'
  config:
    default: standard
- id: preset-standard
  name: '@panedesk/dsh-agent-preset'
  config:
    id: standard
    plugins: []
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `default` | 必填 | 未显式指定时使用的 preset ID |
| `readClaudeAgentTypes` | `false` | 启动时导入 Claude Code 类型；修改后需重启 |

Web 声明来自 `dsh-web-app` bundle。注册表仅在启用 `readClaudeAgentTypes`（缺省关闭）时于启动阶段读取一次 `~/.claude/agents/*.md` 与工作区 `.claude/agents/*.md`，项目同名定义覆盖用户定义。在设置 → Panedesk 中修改此选项，重启 Panedesk 后生效。关闭时不读取这两处目录，导入类型不会进入注册表、上下文面板或委派工具说明；内置模式和模型／提供商委派照常可用。导入类型挂载组合后的 `preset-standard` 插件列表，再叠加其指令和执行期工具守卫，并把映射后的工具名保存在组合代际元数据中，供子代理呈现过滤读取。导入保留模型／强度偏好，不解析提供方。指令插件使用 `@panedesk/dsh-agent-preset-registry/claude-agent-instructions` 子路径：源码启动通过工作区别名解析，安装版加载已发布的 `lib/types/claude-agent-instructions.js` 导出。派遣时从实时目录解析模型偏好，无命中则使用父级路由，显式模型覆盖优先。启动时缺少提供方不会让这些类型变成 broken。`selectedDefault` volatile 字段为新会话覆盖部署默认值。

远端列表以 `importedAgent` 标记导入的 Claude 代理类型，顶层模式选择器隐藏这些条目。导入、解析和按预设 ID 派遣仍使用完整注册表。

Claude Code 工具映射到 Panedesk 能力：`Read` → `read`、`Write` → `write`、`Edit` / `MultiEdit` → `edit`、`Grep` → `grep`、`Glob` → `glob`、`Bash` → 已装配的 `bash` 与 `pwsh`、`WebFetch` → `web_fetch`、`WebSearch` → `web_search`、`TodoWrite` → `todo_write`、`Skill` → `skill`、`AskUserQuestion` → `ask_user_question`，以及 `Agent` → 委派工具（包括改名实例）。`Agent(x, y)` 保留括号内名单，委派时要求显式传入名单内的 `agent_preset`；单独的 `Agent` 不限制类型。后代使用同一执行守卫。执行守卫限制映射能力。子代理呈现保留映射工具以及 `working_directory`、`load_workspace_dependencies` 和 `run_code` 传输工具；`browser` 与确切的 `mcp__` 名称须显式列出。未知名称按定义记录一行提示日志，不阻止导入。

注册表不写入任何声明。`read` Remote 把一条声明的子插件列表按 entry-list YAML 方言（含 `!!js` 条件）渲染回来，供客户端展示 preset 的组成；没有任何接口接受 YAML 写回。新建 preset 或覆盖内置 preset 都是 bundle 补丁：插入一行 `@panedesk/dsh-agent-preset`，或按该行 id 写覆盖补丁，再用 `plugin_manager` 安装到 profile；创造模式在对话中编写这类 bundle。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

每个声明在启动时创建注册表拥有的 scope 和内存 Loader 树。更新或移除声明会让旧代际退役；Agent、子 Agent 和临时历史读取各自持有引用，最后一个引用释放后才销毁插件树。插件注册继承 preset scope，Agent scope 的父链接决定可见性；Agent loop 仍由宿主共享。

preset 的服务提供方及其消费方必须共享同一个 `cordis:group` 隔离 realm。条目局部隔离不会沿 Agent 注册 scope 传播：组外的普通 Context 查找（包括 `agent.ctx`）仍选择 Host realm。`agentPresets.serviceFor()` 显式检查保留的组合，不改变普通服务查找。

激活审计检查导入失败、缺失服务和向全局泄漏的服务。导入失败、激活失败和泄漏会拒绝挂载。等待 Host 服务的行保持挂载，每次读取和绑定都在 Host Loader 树结算后重新审计，因此启动顺序不决定结果。失败只禁用该定义的新绑定。会话日志保存 preset ID 和空白会话的切换记录；重启恢复使用该 ID 的当前定义，缺失时拒绝恢复。若空白会话已记录所请求的 preset 且正运行其当前版本，`select` 不做任何改动，也不追加切换记录或触发 `tools/change`。

`inspectCompositions()` 读取本注册表仍保留的全部代际；传入 Agent 上下文时只选择它绑定的精确代际，在此没有绑定时返回空列表。每个 `AgentPresetInspection` 包含 preset ID、纯数据形式的活动模块引用及解析基址，以及泄漏的服务名。检查器查询运行中的服务，而不是模块级挂载表；结果不包含 Loader 树或 fiber。这些记录定义在 [composition-inventory.ts](src/composition-inventory.ts) 中。

| 文件 | 职责 |
|---|---|
| [index.ts](src/index.ts) | 注册、代际与 Agent 绑定 |
| [mount.ts](src/mount.ts) | 隔离插件树与激活审计 |

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Scope](../../core/scope/README.zh.md) — 注册隔离。
- [Agent](../../core/agent/README.zh.md) — 会话运行时。
- [Cordis](../../../docs/cordis-primer.zh.md) — 插件配置与生命周期。

<a id="model-experience"></a>
## 模型体验

### Preset 选择

#### 模型看到的内容

没有直接内容：所选 preset 的 `plugins` 拥有模型可见的工具和提示词片段。

#### Token 影响

本包自身没有；每个挂载的 `plugins` 行声明自己的工具和片段。

#### KV Cache effect

已有 Agent 保留插件和提示词。新 Agent 从当前定义构建前缀。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- preset 不是安全沙箱：YAML 及插件可以执行 Host 代码。用户覆盖替换完整子插件列表，不自动合并内置列表的未来更新。进程退出后不保存旧代际的插件实现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
