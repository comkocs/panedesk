<div align="center">

# Panedesk

![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011-blue) ![Version](https://img.shields.io/badge/version-1.6.1-blue) ![Node.js](https://img.shields.io/badge/Node.js-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-green) ![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue) ![Electron](https://img.shields.io/badge/Electron-44-blue) ![MIT](https://img.shields.io/badge/license-MIT-green)

开源、插件化的编程智能体工作台，支持 CLI、Web 与桌面客户端。

[English](README.md) | 中文

</div>

## 开始使用

1. 从本仓库的 [GitHub Releases](https://github.com/comkocs/panedesk/releases) 下载并运行最新 Windows 安装包。安装包未签名；SmartScreen 提示时选择「更多信息 → 仍要运行」。
2. 首次启动时，在欢迎页填写 DeepSeek API Key，或选择「使用其他提供方」进入「设置 → 模型 → 添加模型提供商」。
3. 私有插件（如工单台）通过插件管理器安装，填写安装包绝对路径。

1.1 起应用内提示更新；1.0 用户须先手动安装一次 1.1。

## 功能要点

模型路由、subagent、会话账本、权限和沙箱运行在同一工作台。默认 slim 组合提供核心功能，full 组合按需使用；支持提供方配置与插件管理。详见[架构和预设](docs/panedesk/architecture.zh.md)。

## 支持平台

Windows 提供桌面 EXE；Linux 与 macOS 可从源码运行 CLI 和 Web。详见[平台行为与沙箱会话隔离](docs/user/platform-behavior.zh.md)。

## 重要说明

- Panedesk 是 [DSH](https://github.com/deepseek-ai/deepseek-harness) 0.2.1-rc.2 的独立分叉，与 DeepSeek 没有隶属、背书或赞助关系；商标说明见 [BRAND_GUIDELINES.zh.md](BRAND_GUIDELINES.zh.md)。
- Windows 安装包未签名；应用内更新仅连接本仓库 Releases。
- 会话遥测及产品分析默认关闭，可自行打开。

## 从源码构建

需要 Node.js `^22.19.0 || >=24.0.0` 和 pnpm 11（经 Corepack）。在仓库根目录运行：

```sh
pnpm run setup
node apps/cli/lib/bin.js init
```

按提示配置提供方；运行 `node apps/cli/lib/bin.js --help` 查看 CLI 用法。Web 界面使用 `pnpm run dev:web`，打开打印的本机地址。Linux 请先阅读[平台行为](docs/user/platform-behavior.zh.md#platform-behavior)。

## 已知限制

- Windows 共用控制台可能让沙箱命令注入审批按键；请使用 Edge 中经过认证的 Web 前端审批，不用 CLI/TUI 审批。
- 沙箱网络未隔离本机回环与所有抽象套接字，仍可访问本地服务；不可信任务请使用没有本地服务凭据的独立系统账号。
- 仅有 Landlock 的主机不能隐藏可能在沙箱外执行命令的 tmux、screen 或 D-Bus 具名套接字；不可信任务请分账号运行。
- macOS 与 Windows 的宿主代起进程通道尚未核验；不要向不可信任务账号开放高权限宿主自动化。
- Windows 原生沙箱权限执行与桌面 CLI 启动器尚未经实机验收；优先使用 Web 包并保留系统账号隔离。
- Windows 桌面端第三方平台 cookie 仍可被低完整性命令读取；不要在运行不可信任务的桌面浏览器中登录敏感平台账号。
- macOS Web 无法识别产品沙箱的 cookie 回放；请用独立账号运行不可信进程。
- Linux 原生沙箱下 PowerShell 持久终端可能无输出并超时；请改用 Bash。
- 高负载下插件激活可能晚于安装返回；请等激活完成后再重试或执行依赖该插件的任务。
- 无人决定的普通审批没有服务级统一期限，轮次会一直等且不执行写入；请处理请求或取消轮次。
- Web 会话创建或提交曾偶发停滞且原因未定；轮次不再推进时请先检查会话与宿主日志，再重启。
- 预设密集的会话场景曾耗尽 worker 内存，账本不可用现象仍未定因；遇到时请减少活跃预设并保留日志。
- 从非 ASCII 路径构建可选集成可能失败；请使用纯 ASCII 源码路径。
- 向 start.cmd 传自定义端口后，打印链接与轮询仍指默认端口；参数贯通修复前请用默认端口。
- Windows 文件被既有句柄占用可能阻止覆盖；请关闭占用程序后重试。
- Windows 升级准备可能以 EPERM 拒绝目录改名；请关闭旧宿主后重跑准备。
- 升级首启准备曾耗时数分钟且没有分段进度；请保持控制台开启并等待，不要另起一份。
- 过长解压路径可能超过 Windows 路径限制，用户名超过 20 字符时尤其要注意；请直接解到 C:\panedesk\ 等短路径，不再嵌套一层。
- Windows 原生件因链接元数据无法逐字节复现构建；请使用发行产物并核对随附校验值。
- 复用构建树可能把旧 lib 构建块带进包；请从干净检出打包或先清掉旧 lib 输出。
- 停止或升级 Windows 启动器可能遗留隐藏的 PowerShell 轮询进程；请核对并仅关闭对应启动的轮询进程。
- 继承自上游 DSH 0.2.1-rc.2：团队模式下偶尔会有队友子会话未被保存；若发现某位队友的记录缺失，请重新运行该团队任务。

## 与 DSH 的差异

默认 slim、按需 full；遥测默认关闭，CLI 命令为 `panedesk` 和 `pdesk`。组合、命名和配置详见[架构](docs/panedesk/architecture.zh.md)。

## 许可证

MIT。保留上游原句 `Copyright (c) 2026 DeepSeek`，另加 `Copyright (c) 2026 Panedesk contributors`，见 [LICENSE](LICENSE)。从 DSH 继承的第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 参与贡献

请参阅[贡献指南](CONTRIBUTING.zh.md)。
