# Panedesk

[English](README.md) | 中文

**Panedesk**（中文名「窗台」）是一套开源、全插件化的编码代理运行框架（harness）：代理循环、模型路由、子代理、会话账本、权限与沙盒都在同一个运行时里。名字由 *pane*（每个代理在自己的窗格里干活，即「开窗」）和 *desk*（以后派发它们的工单台）拼成。

> Built on DSH (DeepSeek Harness)。Panedesk 是 [DSH](https://github.com/deepseek-ai/deepseek-harness) 0.2.1-rc.2 的独立分叉，与 DeepSeek 没有隶属、背书或赞助关系。「DeepSeek Harness」是 DeepSeek 的注册商标，见 [BRAND_GUIDELINES.zh.md](BRAND_GUIDELINES.zh.md)。

## 状态

里程碑一（瘦身底座）已完成：分叉能构建，能以 headless 单次任务方式接 Anthropic Messages 与 OpenAI Chat Completions 两种接口，能派子代理。目前还没有 Panedesk 自己的界面，也没有发布到 npm。下一步规划：自动开窗引擎、工单台、工作流面板、VS Code 风格深色界面、子代理 map 树、带缓存剩余时间显示的缓存层、Claude Code 式插话与撤回。

以 Linux 和 macOS 为主要平台；Windows 可用于开发。

## 相对 DSH 改了什么

- **默认瘦身。** 启动器依赖从 86 项减到 9 项。默认的 `slim` 预设挂 39 行插件：最小 headless 核心，加上下文压缩、大输出溢出落盘、工具调用超时守卫和 `AGENTS.md` 加载。
- **全量按需。** `full` 预设就是上游 DSH 的 headless 组合（98 行）。它和上游的 `web`、`acp`、`sdk` 几个 profile，在启动器旁边装上 `@panedesk/full` 包后可用（开发工作区里已具备）。
- **隐私默认关。** 会话日志上传、插件清单上传、会话遥测、匿名身份请求头、桌面版产品分析都默认关闭，可以自行打开。
- **去掉品牌开场白。** 系统提示不再以「powered by」那句 harness 自我介绍开头。
- **命令名。** 命令行叫 `panedesk`，短名 `pdesk`。
- 内部包名（`@deepseek-ai/dsh-*`）、环境变量（`DSH_*`）和主目录（`~/.dsh`）这一轮暂不改，待改清单见 `docs/改名待改清单.md`（仅中文）。

## 从源码快速上手

需要 Node.js `^22.19 || >=24`，pnpm 11（经 Corepack）。

```sh
pnpm install                    # git hooks are opt-in: pnpm run hooks:install
node_modules/.bin/tsx scripts/compile-referenced-projects.ts host-libraries
```

选一个模型提供方。slim 预设不预设默认模型路由：没配置之前，运行会报错并指到这里。任何 OpenAI 兼容或 Anthropic Messages 兼容的接口都可以用叠加文件接入（模板在 [examples/providers](examples/providers)），用 `--patch` 传入，或把内容抄进 `$DSH_HOME/profiles/slim/cordis.patch.yml`；文件里只写密钥的环境变量名：

```sh
export MY_GATEWAY_API_KEY=...   # your own key
node apps/cli/lib/bin.js --patch examples/providers/openai-chat.yml "summarize this repository"
node apps/cli/lib/bin.js full "the same task on the full preset"
node apps/cli/lib/bin.js --help
```

启动器自己的参数（`--profile`、`--patch`、各种 dump）要写在 `--json` 这类应用参数前面。在 Windows 上建议设 `DSH_PERMISSION_MODE=read-only`，否则沙盒会通过改目录 ACL 给工作区授写权限。

## 预设

| 预设 | 怎么跑 | 挂了什么 |
|---|---|---|
| `slim`（默认） | `panedesk "任务"` | `@panedesk/slim-base` + `@panedesk/slim-headless` 共 39 行：工具 `read`、`write`、`edit`、`glob`、`grep`、`bash`/`pwsh`、`subagent` |
| `full` | `panedesk full "任务"` | 上游 `dsh-base` + `dsh-headless` 共 98 行（联网工具、技能、目标、工作流、待办、后台任务等） |

`@panedesk/slim-base` 由 `scripts/panedesk/gen-slim-base.ts` 从上游 `dsh-base` 逐行原样摘出生成，上游对共用行的修复可以直接带过来。

## 许可证

MIT。保留上游原句 `Copyright (c) 2026 DeepSeek`，另加 `Copyright (c) 2026 Panedesk contributors`，见 [LICENSE](LICENSE)。从 DSH 继承的第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
