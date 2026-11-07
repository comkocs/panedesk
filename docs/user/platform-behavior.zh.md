# 平台行为与沙箱会话隔离

[English](platform-behavior.md) | 中文

<a id="platform-behavior"></a>
## 平台行为

Linux 上请在 tmux 中，或用 `systemd-run --user --scope -p Delegate=yes` 启动宿主，使其运行于已委派的用户 scope。登录会话的 `session-N.scope` 不委派给用户；直接在其中启动会出现中英启动警告，owner 来源核验不生效。见 [Linux 部署前提](../upgrade-guide/v0.2.1-rc.2/linux-owner-source/guide.zh.md)。

Linux 的仅拒绝退役身份过滤器可能将普通 owner 连接误判为未知来源并拒绝准入；它既不会放行历史产品身份，也不会拒绝新沙箱启动。插入约 10 万、100 万、200 万个退役身份时，估算误报率分别为 0.00047%、2.07%、14.3%。浏览器的 cgroup 身份固定，一旦误中会持续到宿主重启。请先关闭所有沙箱套接字，再重启宿主以清空过滤器。详见 [Linux 升级指南](../upgrade-guide/v0.2.1-rc.2/linux-owner-source/guide.zh.md)。

Windows 本产品沙箱的 TCP 连接即使持有有效 cookie 也不能充当 owner：准入检查宿主持有的作业对象成员身份，不按浏览器完整性、AppContainer 状态或令牌限制判断。查不出连接属主时拒绝 owner；普通浏览器仍可认证。Windows 行为仅经替身验证，未在原生实机验收。经计划任务、WMI、COM、ShellExecute 委托沙箱外进程代起尚未核验；请用独立系统账号运行不可信任务。Windows 行为以本段为准，取代下方会话 cookie 段保留的旧平台限制描述。参见 [Windows 升级指南](../upgrade-guide/v0.2.1-rc.2/windows-owner-source/guide.zh.md)。

Windows 沙箱进程与宿主共用控制台，能向 CLI / TUI 注入按键，冒充所有者答审批或敲命令。Windows 上所有者审批请使用经过认证的 Web 或桌面前端；控制台隔离为后续工作。Windows CLI / TUI 交互启动时会输出此提示。

Windows Web 拒绝新浏览器登录，除非 owner 在受保护配置里关闭新浏览器确认。Windows 发行包首次运行会询问；接受后写入同时带有 `requireOwnerConfirmation: false` 与 `trustedHosts: !!js ctx.webStartup.trustedHosts` 的 connection 条目。升级后请重新登录一次，因为签名密钥已迁址。关闭确认后，持有未使用启动链接即可登录；请保护链接和 cookie。撤销此选择时，移除覆盖条目或把确认设为 `true`，然后重启；Windows 将再次拒绝新浏览器登录，此设置不会撤销已有 cookie。详见[升级说明](../upgrade-guide/v0.2.1-rc.2/owner-private-storage/guide.zh.md)。

Linux/macOS 上所有者私密目录可以位于工作区内，但工作区位于所有者目录内时仍拒绝。Landlock 不授予受保护第一级分支写权；其他现存分支仍可写，但不能在工作区根下新建文件或目录。Windows 在工作区包含所有者存储时允许只读启动，但拒绝写授权。

卸载桌面端不动 Harness home 及其所有者读保护标签。删除 home 或彻底移除 CLI 前，请先停掉全部 Panedesk 进程，再按[手动移除所有者标签](../../packages/sandbox/sandbox-windows-acl/README.zh.md#owner-label-removal-before-uninstall)操作。

受限文件工具和沙箱进程排除 owner 凭据目录，原子替换后仍受保护；普通附件仍可读取。Linux 使用目录挂载或 Landlock 兄弟树放行，macOS 使用 Seatbelt 排除，Windows 对凭据及崩溃目录使用 Medium 禁止向上读写标签。这是指定 owner 材料保护，不是整个 home 的保密隔离。新 Web 浏览器要求 POSIX 控制终端确认；Windows Web 与非交互服务默认拒绝新登录，除非 owner 在受保护配置中显式关闭确认、自担持有启动链接即可获得身份的风险。升级服务部署前请看[登录及服务配置](../../packages/client/connection/README.zh.md#browser-authentication-and-request-trust)。桌面 owner cookie 使用纯内存会话及 IPC；Windows 不标记 userData，因此低完整性命令仍可读取第三方平台 cookie。详见[桌面安全说明](../../apps/desktop/README.zh.md)。

Windows 未显式选择权限模式时默认只读。工作区首次写入会向经过认证的 owner 前端请求确认；设置页也可预授权或撤销工作区。Windows 原生权限执行尚未在 Windows 实机验收。使用默认句柄后端的文件工具读取、列目录、新建文件和改写既有文件已在一台 Windows Server 2025 机器的管理员账号下跑通；普通权限账号尚未在 Windows 实机测试。保护输入排除保留工作区普通位置的写入，而非拒绝整个重叠工作区；[提供者限制](../../packages/sandbox/sandbox-local/README.zh.md#known-limitations-and-deferred-work)区分参数检查与原生执行。无关的插件项目与源码克隆仍可写。已登记的受保护宿主输入在工作区写权授予时建立跨重启保持的基线；HMR 对变化要求经过认证的 owner 确认，拒绝或无人值守时保留运行版本并提示被阻止的变更。`danger-full-access` 表示 owner 明示授予宿主用户的全部写权，包括配置与插件；`plugin_manager` 每次变更仍须 owner 批准。

Windows 状态存储及其祖先必须拒绝沙箱令牌写入；不安全记录不能授权写入，只读启动会省略不可信的工作区配置。撤销在重启后扫描所选工作区，包括 `node_modules`，只有令牌检查确认根与每个匹配显式 ACE 的位置均无写权才报成功。精确目录与 SID 的 `icacls` 命令及限制见 [Windows 恢复指南](../upgrade-guide/v0.2.1-rc.2/windows-workspace-write-access/guide.zh.md)。

旧 Windows 工作区授权若没有产品记录，先关闭相关沙盒进程，再以工作区 owner 身份执行这一行 PowerShell：将 `C:\old-workspace` 换成授写时使用的规范路径，将 `C:\current-workspace` 换成当前位置：`$old='C:\old-workspace'; $dir='C:\current-workspace'; $h=[Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($old)); $sid='S-1-4-'+(([BitConverter]::ToUInt32($h,0)%1073741823)+1)+'-'+(([BitConverter]::ToUInt32($h,4)%1073741823)+1); icacls $dir /remove "*$sid" /T`。此命令只撤该工作区派生主体，不撤所有 `S-1-4-*` 主体；不要替换成 owner 账号或 Everyone。检查失败项，并对每个已知旧授权路径分别执行。仅凭 SID 前缀无法认出未知旧路径。

owner 自装的 MCP 服务器与 provider 按自身能力运行，不受 Panedesk 沙盒与首次写确认约束；安装前请确认其写能力。其 profile 配置仍受保护，受限模型不能直接修改；插件管理变更须经认证的 owner 批准。

在 Linux 与 macOS 上，以 IPC 通道起 CLI 的自写启动器必须在 Node 命令行带上 `--disable-sigusr1`；经 `NODE_OPTIONS` 传入不算，缺少该开关会在读取 profile 与凭据前退出，而不再重启。终端、shell、systemd、pnpm 脚本与 SDK 管道启动不用改。Windows 桌面端 CLI 启动器带有 `--disable-sigusr1` 并有测试覆盖，但尚未在 Windows 实机运行。详见 [IPC 启动升级说明](../upgrade-guide/v0.2.1-rc.2/ipc-cli-launch/guide.zh.md)。

Web 模式下，owner 的登录 cookie 存在系统浏览器的配置目录里，沙箱内的进程读得到。平台前提可用时，连接来源准入会阻止已登记产品沙箱回放 cookie；否则仍可能回放。见[沙箱会话隔离与限制](#sandbox-session-isolation-and-limitations)。

首次写授权时的受保护输入捕获在有界批次之间让出执行，使规模较大的捕获期间 Web 连接与心跳仍可服务。捕获与输入复核仍需扫描受保护输入；已安装插件树与重叠产品 home 的工作区可能增加开销。

| 平台 | 沙盒方式 | 写权限来源 | Bash 缺省 | 已知限制 |
| --- | --- | --- | --- | --- |
| Windows | 低完整性受限令牌与目录能力 ACL；属于部分隔离，针对 owner 目录提供读保护。 | 未显式设模式时只读，不授予工作区写权；仍设置 owner 目录读保护标签。工作区首次写入会请求中英确认；允许后记录授权，工作区可写，受保护路径仍拒写。设置页可预授权或撤销工作区。无人值守会话不弹确认：保持只读并说明开法。显式模式照用。 | 未通过环境或设置选择时禁用；可用 PowerShell。 | 权限收紧（撤销或新增保护根）后，已开进程与句柄不终止，新的工具调用即刻按新策略走。模型持久终端在权限变化后拒绝输入时，需关闭后重开。权限模式选择器不即时反映目录记录。 |
| Linux | bubblewrap（`bwrap`），Landlock 备选。 | 缺省 workspace-write，允许工作区与临时根写入；显式模式覆盖缺省。 | 启用，使用配置的 Bash 或 PATH 上的 `bash`。 | bubblewrap 缺失或不可用时尝试 Landlock；无可用 runner 或无法充分保护宿主输入时拒绝，不会无隔离执行。旧 Landlock ABI 可能只有部分隔离。原生 Node/workflow 进程测试要求 `PANEDESK_CI_NATIVE_SANDBOX=required`，否则打印原因并跳过。未验遍所有内核配置。Linux 原生沙箱下 pwsh 持久终端不可用(读不到输出、会超时)。 |
| macOS | 通过 `sandbox-exec` 使用 Seatbelt。 | 缺省 workspace-write，允许工作区与临时根写入；显式模式覆盖缺省。 | 启用，使用配置的 Bash 或 PATH 上的 `bash`。 | 路径由本机规范化。Seatbelt 不隐藏宿主进程；平台注入回归不等于 macOS 实机验收。 |

<a id="sandbox-session-isolation-and-limitations"></a>
## 沙箱会话隔离与限制

工作区包含产品 home 时（如在 `$HOME` 下启动），首次写授权会逐个扫描重叠的受保护目录；Linux 开发检出使用全新 home 时，headless 与 Web 宿主实测为 18–32 毫秒，已安装插件树的开销可能更大。请在项目目录启动，不要把 `$HOME` 当作工作区。

Bubblewrap 在两种受限模式下均提供私有 `/tmp`，遮挡宿主 tmux、screen、会话总线、X11 与 Wayland 套接字目录，包括显式指定的运行时目录。依赖这些宿主会话的工具在该沙箱内不可用；普通临时文件使用私有 tmpfs。macOS Seatbelt 拒绝临时目录及配置的会话目录下的 UNIX 套接字出站连接；macOS 原生验收仍待实机。见 [runner 细节](../../packages/sandbox/sandbox-local/README.zh.md#known-limitations-and-deferred-work)。

Linux runner 在 ABI 6 及以上内核应用 Landlock 抽象 UNIX 套接字 scope。没有该 scope 时，抽象套接字仍可达：在 X11 桌面上，沙箱进程可能向其他窗口注入按键。此限制不导致拒绝启动。网络隔离尚未补齐；不可信任务请分账号运行。

仅有 Landlock 的机器无法遮挡具名会话套接字路径。若常规用户 tmux、screen 或会话总线落点存在，命令启动会给出中英提示，但不拦启动、不改退出码。这些会话可能在沙箱外执行命令；建议分用户运行。网络隔离尚未补齐；不可信任务请分账号运行。

本机回环网络未受限制。本机 sshd 若接受可用私钥，`ssh localhost` 可绕出沙箱。本轮不遮 `~/.ssh`，以保留经 SSH 的 Git 推送。请勿向不可信任务提供本地服务凭据。因此，会话隔离不等于一般性的沙箱网络保证；显式 full-access 执行仍保持不变。

Linux 上，宿主替模型执行的文件操作——读、写、编辑、建目录、暂存与发布、元数据探查、列目录——逐段打开各规范祖先目录且不跟随链接，经保留的目录描述符处理单个条目；工作区内被换成链接的目录不能使这些操作改道。macOS 与 Windows 上，宿主文件操作仍按路径解析：沙箱内进程把工作区子目录换成链接，可使宿主写到授权工作区之外，缺省 workspace-write 模式下即如此。在这些平台验证过目录相对的原生后端之前，维持此限制。

owner cookie 缺省使用浏览器会话存储；持久化只可通过受保护的 Host 配置启用。缺省新浏览器确认下，在宿主终端确认过的登录只对当次宿主进程有效：宿主重启后，先前确认过的 cookie 被拒，须用新的启动链接重新经终端确认。受保护宿主配置把 `requireOwnerConfirmation` 设为 `false` 时，登录不经终端确认，同一 cookie 跨重启仍有效。在具备 cgroup v2 用户委派及原生套接字 cgroup 归因的 Linux 上，经本地子进程提供方启动并登记的产品沙箱连接即使持有有效 cookie 也会被拒绝。显式启用的实验 Python 运行时使用受管子进程提供方，并保留这项 Linux 登记。缺少前提时，启动给出双语警告，cookie 仍可能被回放；请启用用户会话委派或以不同账户运行不可信进程。套接字归因已在 Linux 7.0 验证，最低内核版本尚未核定。macOS Web 启动提示缺少本产品沙箱连接识别，不声称已阻止回放。Windows 通过宿主持有的作业对象成员关系与 TCP 属主识别产品沙箱；见 [Windows 前提与剩余限制](../upgrade-guide/v0.2.1-rc.2/windows-owner-source/guide.zh.md)。见 [Linux 升级前提](../upgrade-guide/v0.2.1-rc.2/linux-owner-source/guide.zh.md)。见[认证行为](../../packages/client/connection/README.zh.md#browser-authentication-and-request-trust)与[剩余限制](../../packages/client/connection/README.zh.md#known-limitations-and-deferred-work)。
