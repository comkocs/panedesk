# 平台行为与沙箱会话隔离

[English](platform-behavior.md) | 中文

<a id="platform-behavior"></a>
## 平台行为

Windows 沙箱进程与宿主共用控制台，能向 CLI / TUI 注入按键，冒充审批或敲命令。Windows 上审批请使用经过认证的 Web 或桌面前端；控制台隔离为后续工作。Windows CLI / TUI 交互启动时会输出此提示。

Windows 原生沙箱权限执行尚未在 Windows 实机验收。文件工具使用普通路径写入。[提供者限制](../../packages/sandbox/sandbox-local/README.zh.md#known-limitations-and-deferred-work)区分参数检查与原生执行。无关的插件项目与源码克隆仍可写。`danger-full-access` 授予宿主用户的全部写权，包括配置与插件。

Windows 低完整性命令仍可读取第三方平台 cookie。详见[桌面说明](../../apps/desktop/README.zh.md)。

经计划任务、WMI、COM、ShellExecute 委托沙箱外进程代起尚未核验；请用独立系统账号运行不可信任务。

在 Linux 与 macOS 上，以 IPC 通道起 CLI 的自写启动器必须在 Node 命令行带上 `--disable-sigusr1`；经 `NODE_OPTIONS` 传入不算，缺少该开关会在读取 profile 与凭据前退出，而不再重启。终端、shell、systemd、pnpm 脚本与 SDK 管道启动不用改。Windows 桌面端 CLI 启动器带有 `--disable-sigusr1` 并有测试覆盖，但尚未在 Windows 实机运行。详见 [IPC 启动升级说明](../upgrade-guide/v0.2.1-rc.2/ipc-cli-launch/guide.zh.md)。

Web 模式下，登录 cookie 存在系统浏览器的配置目录里，沙箱内的进程读得到。见[沙箱会话隔离与限制](#sandbox-session-isolation-and-limitations)。

| 平台 | 沙盒方式 | 写权限来源 | Bash 缺省 | 已知限制 |
| --- | --- | --- | --- | --- |
| Windows | 低完整性受限令牌与目录能力 ACL；属于部分隔离。 | 未显式设模式时只读，不授予工作区写权。工作区首次写入会请求中英确认；允许后记录授权，工作区可写。设置页可预授权或撤销工作区。无人值守会话不弹确认：保持只读并说明开法。显式模式照用。 | 未通过环境或设置选择时禁用；可用 PowerShell。 | 权限收紧后，已开进程与句柄不终止，新的工具调用即刻按新策略走。模型持久终端在权限变化后拒绝输入时，需关闭后重开。权限模式选择器不即时反映目录记录。 |
| Linux | bubblewrap（`bwrap`），Landlock 备选。 | 缺省 workspace-write，允许工作区与临时根写入；显式模式覆盖缺省。 | 启用，使用配置的 Bash 或 PATH 上的 `bash`。 | bubblewrap 缺失或不可用时尝试 Landlock；无可用 runner 时拒绝，不会无隔离执行。旧 Landlock ABI 可能只有部分隔离。原生 Node/workflow 进程测试要求 `PANEDESK_CI_NATIVE_SANDBOX=required`，否则打印原因并跳过。未验遍所有内核配置。Linux 原生沙箱下 pwsh 持久终端不可用(读不到输出、会超时)。 |
| macOS | 通过 `sandbox-exec` 使用 Seatbelt。 | 缺省 workspace-write，允许工作区与临时根写入；显式模式覆盖缺省。 | 启用，使用配置的 Bash 或 PATH 上的 `bash`。 | 路径由本机规范化。Seatbelt 不隐藏宿主进程；平台注入回归不等于 macOS 实机验收。 |

<a id="sandbox-session-isolation-and-limitations"></a>
## 沙箱会话隔离与限制

请在项目目录启动，不要把 `$HOME` 当作工作区。

Bubblewrap 在两种受限模式下均提供私有 `/tmp`，遮挡宿主 tmux、screen、会话总线、X11 与 Wayland 套接字目录，包括显式指定的运行时目录。依赖这些宿主会话的工具在该沙箱内不可用；普通临时文件使用私有 tmpfs。macOS Seatbelt 拒绝临时目录及配置的会话目录下的 UNIX 套接字出站连接；macOS 原生验收仍待实机。见 [runner 细节](../../packages/sandbox/sandbox-local/README.zh.md#known-limitations-and-deferred-work)。

Linux runner 在 ABI 6 及以上内核应用 Landlock 抽象 UNIX 套接字 scope。没有该 scope 时，抽象套接字仍可达：在 X11 桌面上，沙箱进程可能向其他窗口注入按键。此限制不导致拒绝启动。网络隔离尚未补齐；不可信任务请分账号运行。

仅有 Landlock 的机器无法遮挡具名会话套接字路径。若常规用户 tmux、screen 或会话总线落点存在，命令启动会给出中英提示，但不拦启动、不改退出码。这些会话可能在沙箱外执行命令；建议分用户运行。网络隔离尚未补齐；不可信任务请分账号运行。

本机回环网络未受限制。本机 sshd 若接受可用私钥，`ssh localhost` 可绕出沙箱。本轮不遮 `~/.ssh`，以保留经 SSH 的 Git 推送。请勿向不可信任务提供本地服务凭据。因此，会话隔离不等于一般性的沙箱网络保证；显式 full-access 执行仍保持不变。

Linux 上，宿主替模型执行的文件操作——读、写、编辑、建目录、暂存与发布、元数据探查、列目录——逐段打开各规范祖先目录且不跟随链接，经保留的目录描述符处理单个条目；工作区内被换成链接的目录不能使这些操作改道。macOS 与 Windows 上，宿主文件操作仍按路径解析：沙箱内进程把工作区子目录换成链接，可使宿主写到授权工作区之外，缺省 workspace-write 模式下即如此。在这些平台验证过目录相对的原生后端之前，维持此限制。

登录 cookie 使用浏览器会话存储，宿主重启后仍然有效。见[认证行为](../../packages/client/connection/README.zh.md#browser-authentication-and-request-trust)与[剩余限制](../../packages/client/connection/README.zh.md#known-limitations-and-deferred-work)。
