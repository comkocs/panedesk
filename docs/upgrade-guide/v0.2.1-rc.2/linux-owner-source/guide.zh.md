---
kind: upgrade-guide
description: "当原生套接字归因和用户 cgroup 委派可用时，Linux 产品沙箱连接不再能使用 owner cookie。"
---

# Linux owner 连接来源

[English](guide.md) | 中文

## 变更

此前，owner cookie 可以授权产品沙箱连接。Linux owner 准入现在通过客户端套接字识别登记的产品 cgroup，在启动令牌交换、API Peer 创建或已认证分派之前拒绝产品及无法核实的来源。这覆盖 HTTP、HTTPS 和 WebSocket 升级。普通宿主进程及浏览器仍为非产品来源。它不管辖受信任宿主插件代其他进程发起的请求，也不管辖独立的 host-admin 凭据协议。

Linux 要求 cgroup v2 用户会话委派和原生套接字归因；Linux 7.0 已验证，最低内核版本尚未核定。缺少任一前提时，宿主以中英文警告，返回非产品，不能防止 cookie 回放。委派启动 scope 不可用时也只警告，不拒绝命令。macOS 保留其警告；Windows 使用[基于 Job 的判定器](../windows-owner-source/guide.zh.md)。见[保留策略](../../../../packages/subprocess/subprocess-local/README.zh.md#linux-sandbox-connection-identity)。cookie 持久化、一次性令牌及新浏览器确认不变。

Linux 上，过滤器命中会将无关 owner 连接判为未知并拒绝准入，但不拒绝新沙箱，也不放行历史产品身份。退役身份达到 10 万、100 万、200 万个时，估算误报率为 0.00047%、2.07%、14.3%。固定的浏览器 cgroup 身份使误报持续到宿主重启。请先关闭所有沙箱套接字，再重启以清空过滤器。

显式启用的实验 Python 运行时现在要求子进程提供方，并向其传递隔离事实。本地 Linux 提供方在相同前提下登记其受限进程；已发布 profile 仍不启用此运行时。fd-3 协议及模型环境仅含 TMPDIR 的语义不变。SSH 隔离在远端普通进程与终端执行中保留产品标记；客户端和 helper 须一起升级。其登记发生在远端，不能识别通向调用 Host 网关的连接，也不保护独立运行的远端 Host。见[远端归属与限制](../../../../packages/ssh/ssh/README.zh.md#understand-the-implementation)。

## 迁移

1. 同时升级原生入口包和匹配的平台包；自定义 Linux 包必须重编 `system.node`。缺少套接字归因的旧 addon 会触发已说明的限制，不会声称已强制执行。
2. 请管理员启用 cgroup v2 用户委派。在 tmux 中，或用 `systemd-run --user --scope -p Delegate=yes` 启动宿主：登录会话的 `session-N.scope` 不委派给用户，会导致中英启动警告，owner 来源核验不生效。Panedesk 不修改系统单元或内核配置。无法取得委派时，以不同账户运行不可信进程；警告表示存在安全限制。
3. 自定义执行提供方必须将 Linux 隔离返回的 `productSandbox: true` 保留到 `SubprocessSpawnSpec` 或 `SubprocessTerminalSpawnSpec`，不得从 argv 或 scope 名推断。见[提供方前提及生命周期](../../../../packages/subprocess/subprocess-local/README.zh.md#linux-sandbox-connection-identity)。
4. 确认普通浏览器仍可认证，而携带其他方面有效的 owner cookie 的产品沙箱请求收到双语 403。单连接查询失败也返回 403，不会将有能力宿主降级为放行。重启宿主前，停止沙箱进程并关闭其套接字；套接字身份可能比创建它的进程活得更久。
