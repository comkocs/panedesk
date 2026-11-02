# Panedesk

[English](README.md) | 中文

**Panedesk**（中文名「窗台」）是一套开源、全插件化的编码代理运行框架（harness）：代理循环、模型路由、子代理、会话账本、权限与沙盒都在同一个运行时里。名字由 *pane*（每个代理在自己的窗格里干活，即「开窗」）和 *desk*（以后派发它们的工单台）拼成。

> Built on DSH (DeepSeek Harness)。Panedesk 是 [DSH](https://github.com/deepseek-ai/deepseek-harness) 0.2.1-rc.2 的独立分叉，与 DeepSeek 没有隶属、背书或赞助关系。「DeepSeek Harness」是 DeepSeek 的注册商标，见 [BRAND_GUIDELINES.zh.md](BRAND_GUIDELINES.zh.md)。

## 状态

公开仓包含支持模型路由与 subagent 的 headless CLI（命令行界面），以及 Web 和桌面客户端。Web 组合提供会话 subagent 树与只读监看、账本统计台、节点健康与管理页、只读 skill（技能）清单。工位编排及其界面需显式启用；安装相关包不会自动开窗。另有私有插件，本页不展开。

下一步规划：先准备对外发布，再完善长窗与 subagent 守护，随后实现上游同步自动化。公开组合与配置见 [Panedesk 架构](docs/panedesk/architecture.zh.md)。

## 平台行为

Windows 未显式选择权限模式时默认只读。工作区首次写入会向经过认证的 owner 前端请求确认；设置页也可预授权或撤销工作区。Windows 原生权限执行尚未在 Windows 实机验收。保护输入排除保留工作区普通位置的写入，而非拒绝整个重叠工作区；[提供者限制](packages/sandbox/sandbox-local/README.zh.md#known-limitations-and-deferred-work)区分参数检查与原生执行。无关的插件项目与源码克隆仍可写。已登记的受保护宿主输入在工作区写权授予时建立跨重启保持的基线；HMR 对变化要求经过认证的 owner 确认，拒绝或无人值守时保留运行版本并提示被阻止的变更。`danger-full-access` 表示 owner 明示授予宿主用户的全部写权，包括配置与插件；`plugin_manager` 每次变更仍须 owner 批准。

| 平台 | 沙盒方式 | 写权限来源 | Bash 缺省 | 已知限制 |
| --- | --- | --- | --- | --- |
| Windows | 低完整性受限令牌与目录能力 ACL；属于部分隔离，不隔离读取。 | 未显式设模式时只读，不改 ACL。工作区首次写入会请求中英确认；允许后记录授权并给该目录加写权限。设置页可预授权或撤销工作区。无人值守会话不弹确认：保持只读并说明开法。显式模式照用。 | 未通过环境或设置选择时禁用；可用 PowerShell。 | 权限收紧（撤销或新增保护根）后，已开进程与句柄不终止，新的工具调用即刻按新策略走。模型持久终端在权限变化后拒绝输入时，需关闭后重开。权限模式选择器不即时反映目录记录。 |
| Linux | bubblewrap（`bwrap`），Landlock 备选。 | 缺省 workspace-write，允许工作区与临时根写入；显式模式覆盖缺省。 | 启用，使用配置的 Bash 或 PATH 上的 `bash`。 | 无可用 runner 时拒绝。旧 Landlock ABI 可能只有部分隔离；未验遍所有内核配置。 |
| macOS | 通过 `sandbox-exec` 使用 Seatbelt。 | 缺省 workspace-write，允许工作区与临时根写入；显式模式覆盖缺省。 | 启用，使用配置的 Bash 或 PATH 上的 `bash`。 | 路径由本机规范化。Seatbelt 不隐藏宿主进程；平台注入回归不等于 macOS 实机验收。 |

## 相对 DSH 改了什么

- **默认瘦身。** 默认的 `slim` 预设提供最小 headless 核心、上下文压缩、大输出溢出落盘、工具调用超时守卫和 `AGENTS.md` 加载。当前插件行数与归属以[生成的预设表](docs/panedesk/architecture.zh.md)为准。
- **全量按需。** `full` 预设就是上游 DSH 的 headless 组合。它和上游的 `web`、`acp`、`sdk` 几个 profile，在启动器旁边装上 `@panedesk/full` 包后可用（开发工作区里已具备）。
- **隐私默认关。** 会话日志上传、插件清单上传、会话遥测、匿名身份请求头、桌面版产品分析都默认关闭，可以自行打开。
- **去掉品牌开场白。** 系统提示不再以「powered by」那句 harness 自我介绍开头。
- **命令名。** 命令行叫 `panedesk`，短名 `pdesk`。
- **改名后的命名。** 启动器包是 `panedesk`（命令 `panedesk` 与 `pdesk`），其余工作区包一律 `@panedesk/*`、只换了作用域（所以仍有 `@panedesk/dsh-*` 这样的名字）；主目录默认 `~/.panedesk`，用 `PANEDESK_HOME` 覆盖，`~/.dsh` 与 `DSH_HOME` 一律不读。用户变量有 `PANEDESK_PERMISSION_MODE`、`PANEDESK_TELEMETRY_*`、`PANEDESK_TOOLS_MODE`、`PANEDESK_AGENTS_HOME`（缺省仍 `~/.agents`），其余 `DSH_*`（测试、快照、CI、发布用）名字不变。改名本身由 `scripts/panedesk/rename/` 做映射与重放（那里有英文 README，上游修复先过这个脚本再合）。

## 从源码快速上手

需要 Node.js `^22.19 || >=24`，pnpm 11（经 Corepack）。

在仓库根目录运行一条安装命令：

```sh
pnpm run setup
```

它会冻结安装依赖，编译原生扩展与宿主引用库（包括 CLI 运行时），检查 CLI 运行闭包，并初始化默认 slim profile。无需自行运行 `compile-referenced-projects`。Git 钩子仍需通过 `pnpm run hooks:install` 主动安装。

直接运行构建后的 CLI；也可先配置 `PNPM_HOME`，再用 `pnpm run setup -- --link` 安装全局 `pdesk` 与 `panedesk` 命令：

```sh
node apps/cli/lib/bin.js --help
node apps/cli/lib/bin.js init
```

全局命令链接完成后，第二条命令就是 `pdesk init`。选择 Anthropic Messages、OpenAI Chat Completions 或 OpenAI Responses，再填写 base URL 与模型 ID。密钥推荐只填写环境变量名，也可现场不回显输入，存入仅当前用户可读的凭据件。Init 在 `$PANEDESK_HOME/cordis.patch.yml` 中只写密钥引用，更新已有 patch 前先备份。选择环境变量方案时，须在运行环境中设置该变量；slim 在完成配置前没有模型路由。

```sh
node apps/cli/lib/bin.js "summarize this repository"
```

手动提供方叠加配置见[提供方示例](examples/providers)与[补丁顺序说明](docs/panedesk/architecture.zh.md)。启动器参数（`--profile`、`--patch`、各种 dump）要写在 `--json` 这类应用参数前面。在 Windows 上运行工具前，请先看平台表。

## 预设

当前插件行数与归属见[生成的预设表和组合说明](docs/panedesk/architecture.zh.md)。表由 `scripts/panedesk/gen-slim-base.ts --table` 生成；统计的是应用 headless 补丁、平台条件和叠加配置前的底座声明行数，不是已启用插件数。

npm dry-run、在用的发布辅助脚本与继承的发布命令见[发布脚本说明](docs/panedesk/release.zh.md)。

## 许可证

MIT。保留上游原句 `Copyright (c) 2026 DeepSeek`，另加 `Copyright (c) 2026 Panedesk contributors`，见 [LICENSE](LICENSE)。从 DSH 继承的第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
