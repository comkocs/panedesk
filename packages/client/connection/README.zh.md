---
description: "Web GUI 的浏览器与 Host 之间的协议层：Remote RPC、带重连的事件流投递、精确 Fetch 路由、/api HTTP 桥与浏览器信任栅栏。"
kind: "package-reference"
---

# @panedesk/dsh-client-connection

[English](README.md) | 中文

## 概述

本包承载浏览器到 Host 的 Remote 调用、精确 Fetch 响应与 connection generation。Client 插件挂载 `ctx.connection`，其中包含当前页面的 loopback 状态、通用 RPC、当前 generation 及其 Host 信息、可观察的恢复状态、立即重连命令，以及单一 generation source 的注册点。source 报告 ready 后 generation 才可见；source 结束、失败、被撤回或显式 stop 都会清空它，再由 `ConnectionController` 执行重试策略。

## 目录

- [使用本包](#use-this-package)
- [浏览器认证与请求信任](#browser-authentication-and-request-trust)
- [Connection generation](#connection-generation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`./client` 导入在 Node 中选择独立的 `lib/client.node.js` ESM bundle，在浏览器中选择 `lib/client.browser.js` loader factory。Web Host 仍以逻辑 URL `/plugins/.../client.js` 提供浏览器导出。非页面 Cordis 树应导入 Client 入口；独立的包根入口是 Host 入口。

静态桌面页面可以通过 `__DSH_TRANSPORT__.streamBaseUrl` 提供其所拥有 Host 的 HTTP origin。Gateway 将该 origin 用于 WebSocket，HTTP 传输仍独立选择。桌面载体负责认证；仅设置 origin 不会授予访问权限。

一元 RPC 请求使用 JSON。Host handler 可以返回已经从 JSON 兼容结果值中分离的字节附件，每个附件标明其相对于结果的路径。Connection 将这些值写为 multipart 部分。JSON `metadata` 部分包含带 `null` 占位值的 RPC 响应信封，以及记录各路径、codec 和部分标识符的附件表。路径使用字符串键与数字数组下标，不保留任何业务字段名。Client 校验信封、`rpcId`、附件表和各部分，再将每个字节值恢复为以 `ArrayBuffer` 为底层缓冲区的视图。没有附件的结果（包括 base64 字符串）与失败仍使用 JSON。逻辑 RPC 载体直接返回解码后的原生值。Connection 不识别二进制字段，也不依赖 Typert；拥有结果协议的 handler 在返回前执行按类型或按运行时值的投影。不支持二进制参数、事件和二进制流式结果。

浏览器通过 HTTP POST 执行 Remote 一元调用；API Gateway 自己拥有 `/api/remote.mux` WebSocket 及其逻辑流。由 shell 持有的组合通过 `connection.rpc.open` 提供等价的 Remote 流（包括流的上行），不打开 WebSocket。浏览器插件读取页面 transport、恢复设置与 location，再委托 `installConnection(ctx, options)`。持有自身载体的组合可以直接调用同一个安装函数；整机客户端测试档就是这一消费者。非页面载体通过 `ClientTransportHooks.createWebSocket` 使用与 HTTP 相同的认证 Cookie，并提供 `streamBaseUrl`；`ConnectionHandle.openWebSocket()` 根据该 base 解析 Mux 路径，再调用所选工厂。每次调用都会创建一个归所属 Context 的服务，因此同一 realm 中的多棵 Client 树可以使用不同载体。Host half 始终提供与载体无关的 RPC 注册表和精确 `GET`/`HEAD`/`POST` 路由注册表。存在 Web 载体时，它还持有唯一 `/api` route、Fetch bridge、浏览器认证与 Host/Origin 校验；由 shell 持有的载体则直接分派共享 Fetch handler。每条精确路由会在 bridge 读取任何字节前声明缓冲或流式请求体处理方式。Typert Gateway 认领生成的 Remote endpoint，功能包注册 Session 日志下载、原始文件上传等非 JSON 响应，未认领的请求返回 404。Loopback hostname 判定只供浏览器侧当前页面状态使用，留在包内。浏览器原始请求体传输由 [`dsh-client-file-upload`](../file-upload/README.zh.md) 提供。

-----

<a id="browser-authentication-and-request-trust"></a>
## 浏览器认证与请求信任

新浏览器 cookie 保持待确认，直到 owner 在 POSIX Host 的控制终端回答 `y`。提示显示转义后的 User-Agent、请求时刻与来源地址。取消或未答复的提示拒绝访问；`ownerConfirmationTimeoutMs` 限制等待时长，默认 60000 毫秒。待确认或拒绝的 cookie 不能取得 owner Peer，也不能使用 `/connect`；批准后刷新干净页面。经过待确认流程的 cookie 在 Connection 重启后需要重新登录。Windows Web 与没有交互控制终端的启动方式拒绝新浏览器登录。升级服务方式运行的 Web 实例前，owner 可以在受保护配置文件的 `client-connection` 行设置 `requireOwnerConfirmation: false`。关闭确认后，持有未使用启动链接即可成为 owner，风险由 owner 自担。桌面 IPC 认证不使用此终端提示。只有取得控制终端后才加载 readline 内置模块，因此 Worker 镜像不会导入仅宿主可用的输入模块。

通过 Web 载体访问时，每个 Host RPC 方法和 WebSocket 流都要求经过认证的浏览器或 API Peer，不存在按方法区分的 loopback 层。Host 生成随机的一次性启动令牌，五分钟后过期。`dsh-web-app` 打印并打开带 `?token=...` 的应用 URL，保留调用方的 authority 与挂载；`frontend-static` 把根路径和 index 请求交给 `ctx.connection.authorizeIndex`，后者只在 `GET /` 接受该令牌，写入绑定 authority 的签名 cookie，再重定向到干净的 `./`，移除令牌并保留请求目录。缺失、过期、畸形或 authority 不匹配的 cookie 会在 RPC 分发前得到 401。静态资源保持公开。HTTP 载体只在根路径交换接受 query token，绝不在 `/connect` 接受，也不接受 Authorization header token。已消费或过期的链接不能再次签发 cookie。

cookie 签名密钥是 `ctx.credentials` 中由 `client-connection/browser-session` 拥有的 grant 记录。本地提供方把它持久化到 `$PANEDESK_HOME/private/.credentials.yaml`；`BrowserAuth` 在 Connection 激活期间加载或创建该记录，并把密钥留在内存中，因此请求认证同步执行。删除或替换该记录会在下一次 Connection 激活时生效。浏览器与 API cookie 默认采用不带 `Max-Age` 或 `Expires` 的会话 cookie，签名中的签发与过期区间仍限制为 30 天。在受保护的 Host 配置中显式设置正整数 `cookieMaxAgeDays`，才会启用对应天数的持久存储；没有环境变量、命令行或请求覆盖入口。浏览器会话恢复可能保留会话 cookie，因此这不是撤销机制。cookie 在确定性名称与签名 payload 中同时绑定规范化 hostname 和 port。它是 host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`；收到该 index 请求的监听器提供 TLS 时才带上 `Secure`，且只由该监听器自身的协议决定，`publicUrl` 声明与转发头都不参与判断。

Host 持有的连接来源适配器可在消费启动令牌、发布 API Peer 或分派已认证请求之前拒绝 owner 准入。判定区分本产品沙箱、非本产品和未知来源；沙箱与未知结果返回中英 403 拒因。HTTP keep-alive 与 WebSocket 升级共享 socket 缓存，关闭时释放。适配器不是请求字段或配置绕过开关；具体平台识别必须由 Host 提供。

HTTPS cookie 名称与签名 audience 包含 `https:` scheme，因此即使 hostname 和 port 相同，HTTP cookie 也无法通过 TLS 监听器的认证。默认端口按监听器的 scheme 归一化。既有 HTTP cookie audience 保持不变。

认证之前，每个请求都经过 `src/api-request-trust.ts`。其 `Host` 必须是 loopback、等于监听器的绑定 IP 字面量（端口不限），或与 `trustedHosts` 条目匹配：带端口的 `host:port` 精确匹配，不带端口的条目匹配任意端口。Host 与配置条目按监听器的 scheme 做 WHATWG 默认端口归一化，不采信转发 header 或 `Origin`。附带的 HTTP(S) `Origin` 必须指向同一 authority；此时按 Origin 的 scheme 解析 Host，以支持 HTTPS 代理转发到 HTTP 上游；`sec-fetch-site: cross-site` 一律拒绝。畸形配置 authority 会让插件加载失败。`allowsRemoteAuthorities` 报告 `trustedHosts` 是否允许非 loopback authority；接受绑定 IP 不会改变该列表。这些检查防御 DNS rebinding 与跨站浏览器请求，绝不建立身份。Host/Origin 校验失败返回 403；Host 可信但未认证的请求返回 401。`dsh web --host 0.0.0.0` 不受支持。决策记录：[浏览器请求信任](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md)与[浏览器令牌认证](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md)。

每个请求都代表一个 Peer：`principal` 指明调用方，`interactions` 决定能否参与转发事件，`signal` 在 scope 结束时中止。`ctx.connection.browserPeer` 由通过认证的浏览器连接共享，principal 为 owner，默认 `interactions: 'answer'`。`ctx.connection.admit(request)` 检查信任与浏览器或 API 认证，返回凭据对应的存活 Peer 或拒绝状态；`/api` 路由和 Gateway WebSocket 升级都使用该结果，处理器接收本次调用的 Peer。`ctx.connection.createPeer({ principal, interactions? })` 创建独立进程内 Peer，由读取该服务的 Context 或其自身的 `dispose()` 释放；省略 interactions 时默认 `answer`。导出的 `Peer` 类接受相同参数。`fetch(request, peer)` 和 HTTP bridge 必须显式接收 Peer；对非 owner Peer，exact route 返回 403。其他 principal 的方法级访问归 [`dsh-api-remote-access`](../../api/remote-access/README.zh.md)。

API 调用方携带已认证的浏览器 owner Cookie 请求 `GET /connect?interactions=answer|none`，创建 principal 为 owner 的 Peer，返回 302、Mux 目标地址与签名 API Cookie。启动 URL 本身不能授权此交换。CLI Web 用户打开新的启动链接一次，并在 Host 控制终端批准浏览器；桌面载体通过继承的 IPC 取得 cookie，只在内存中保存。外部 HTTP API 调用方必须通过 owner 控制的渠道取得 owner cookie。TypeScript 与 Python SDK 的 running-Host 凭据文件流程独立于此 Web 交换。API 连接默认 `none`，非法或重复声明返回 400。HTTP 可先于 WebSocket 建立。一条 API socket 负责清理：重复关联返回 409，关闭时移除其 Peer，之后使用该 Cookie 的 HTTP 被拒绝。已受理 unary 调用保留请求级取消，但 Peer 释放后 `invocation.peer.ctx` 不再接受新的 effect 注册。API 调用方将 Cookie 与浏览器存储分开；两者使用相同的 authority 专属 Cookie 名称。

通过认证的共享 HTTP 请求在传输请求体之前经过 `connection/request` waterfall。监听器可以拒绝新请求，或等待 `next()` 直到响应完成；释放所属 fiber 会移除准入行为。Desktop 使用此扩展点，在已批准的安装期间锁住新的 API 工作，而不取消已接纳的工作。客户端断开会中止处理函数的信号；桥接器停止写入 socket，并排空剩余响应块。WebSocket 流仍由 API Gateway 负责。

<a id="connection-generation"></a>
## Connection generation

未显式指定时，`installConnection` 将页面的 `interactions` 解析为 `answer`，非页面调用方解析为 `none`。只有回答型 Client 把内部 `$events` 逻辑流注册为唯一 generation source，与有无 `$on` 订阅无关。Host 在 API Remotes source factory 同步挂好所有增量 listener 后，先发送唯一 `{ type: 'ready', clientId, host: { home } }` 项，再发送事件。`ConnectionController` 仅在收到该 ready 项后发布 generation 并调用 `onConnected`，因此 baseline 不会跑在增量 listener 前面。

`$events` 结束、Remote 流报错、收到非 ready 首项或畸形事件项，都会使当前 generation 失效。默认情况下，挂起的握手在 3 秒后记录 Host 响应缓慢告警，在 15 秒后记录就绪超时并中止，包含等待物理 socket 的时间。取消后，source 必须停止投递、释放资源并结束，替换 source 才能启动；已取消 source 迟到的 ready 不能发布 generation。浏览器报告网络可用时，Controller 发布 `connecting`，并在 500ms、1s、2s、4s、8s 与 10s 上限内采用 50%–100% 抖动重试，达到终档后继续尝试直到恢复。每次重试都要求 Gateway 替换一次物理 WebSocket，再重开 `$events`。

`ctx.connection.reconnect()` 会中断活动工作、重置序列，并立即开始 retry 1。浏览器 `offline` 会中断活动工作、发布 `disconnected` 并暂停自动尝试；下一次 `online` 转换会重置序列并从 500ms 档开始。只有 ready 项会发布 `connected`。Gateway mux 不拥有独立重试调度。

可通过 Host Connection 行的 `config.recovery` 覆盖重试上限、增长因子或握手告警与取消时间；[配置目录](../../../docs/config-catalog.zh.md#panedeskdsh-client-connection)列出接受的字段。Host 校验这些值，并将其注入所提供的每个页面。Client 在提供 Connection 前校验启动数据，并在 Gateway 启动循环时采用这些默认值；显式传给 `start()` 的时序覆盖优先。增长因子必须是至少为一的有限数。若就绪、失败、取消或硬期限先于告警发生，该告警会被取消。修改 Host 恢复配置后需重新加载页面。


<a id="model-experience"></a>
## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **缓冲型 `/api` 路由会把每个请求体保留在内存里**：`maxRequestBodyBytes`（默认 300 MiB，按默认 200 MiB 图片总量上限经 base64 膨胀加信封余量得出）限制普通图片与 RPC 信封。显式启用的流式路由接收带背压的分块并绕过总量上限；路由实现负责持久化、取消与存储配额。
- **明文 HTTP 监听器会在传输中暴露 bearer cookie**：此类部署无法给浏览器 cookie 加 `Secure`；若把同一 authority 暴露到网络上，会话 cookie 可能泄露；在 Web 载体（[`dsh-host-webserver`](../../host/webserver/README.zh.md)）上配置 TLS 即可让 cookie 带上 `Secure` 并只经 TLS 发送。
- **未使用的 API Peer 可以保留到 Host 退出**：调用方从未建立 WebSocket 时，其轻量记录不受建联期限或空闲回收约束。Cookie 过期仍拒绝新请求。其生命周期 socket 关闭或 Host 重启后，API 调用方必须通过 `/connect` 重新接入。
- **macOS 不识别本产品沙箱连接**：Web 载体启动会给出中英提示，但不拒绝启动。沙箱仍可回放有效 owner cookie；M9 正式发布前必须补齐连接来源拦截。会话 cookie 不消除这一缺口。
- **没有 logout 操作**：清除浏览器 cookie 会结束单个浏览器会话；删除 owner 凭据记录并重启 `dsh` 会撤销全部会话。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
