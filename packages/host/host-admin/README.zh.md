---
description: "Explicit authenticated administration for an already running host."
kind: "package-reference"
---

# `@panedesk/dsh-host-admin`

[English](README.md) | 中文

## 概述

运行中宿主的可选管理通道。导入或省略 `runtime` 不创建监听、凭据或第二个引擎。

## 目录

- [用途](#purpose)
- [配置与身份](#configuration-and-identity)
- [持久化与恢复](#persistence-and-recovery)
- [模型体验](#model-experience)
- [已知限制与待完成项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="purpose"></a>
## 用途

管理方法为 `node.status`、`node.rebuild`、`engine.pending`、`engine.approve`、`engine.operation`、`engine.query`、`engine.cancel`、`engine.callbackResolve`、`source.operations`、`source.abandon`、`source.resend`。新增的 `sdk.invoke` 只向已注册 SDK 命名空间分派，依次走其解码、授权、执行和编码函数；未注册或已卸载的命名空间返回 `method-unavailable`。传输限定本机回环，拒绝浏览器来源、请求 cookie、非固定路径、错误 Host、旧进程代次及错误认证头。请求与响应均受完整帧字节上限约束。

<a id="configuration-and-identity"></a>
## 配置与身份

`runtime` 必须显式填写 `directory`、`nodeId`、`principalId`、`port`、`maxFrameBytes`、`requestTimeoutMs`、`maxPending`、`maxStoreBytes`、`maxOperations`。测试使用 `port: 0` 分配临时端口；部署端口由配置决定。配置经 Loader 装配，入口无命令行启动能力。

Admin 端点仅接受实际监听端口对应的 IPv4 回环 Host authority，并保留空 HTTP 403 拒绝回包。共享 `listenAuthenticatedLoopback` 助手可为 [node-link](../../seat/node-link/README.zh.md#configuration-and-identity) 接收精确回环转发 authority 名单与安全 Host 拒因报告回调；admin 均不传入。认证、固定路径与浏览器请求头检查仍为必需。`callLoopback` 仅在显式请求时解码有界 Host 拒因；其他调用方保留泛化传输错误。

`directory` 为独占绝对路径，POSIX 目录权限必须为 `0700`，文件必须为当前属主的单硬链接普通文件且权限为 `0600`。祖先路径不得含符号链接；部署者还须保证祖先目录不可被非受信账号替换。Windows 显式注入本包的 `hostAdminFiles: directory => new WindowsPrivateFiles(directory)`，并将同一工厂传给 `callHostSdk` 的 `privateFiles` 选项；POSIX 默认装配不变。Windows 启动最多等待 `requestTimeoutMs`，直到工厂提供者活动；不回退 POSIX，工厂缺失或文件失败进入 Cordis 启动错误链。消费者卸载会取消等待而不误报工厂缺失；失活的启动会释放资源，不再发布服务。实现只接受带盘符的本地绝对路径，拒绝路径各级重解析点，要求关闭 DACL 继承、仅当前用户 SID 一条 FullControl 允许项且属主 SID 一致；既有 ACL 不符即拒，不修复。新建空对象先设 ACL，再写内容并刷盘；同目录以写穿透 `MoveFileExW` 替换，访问或共享冲突最多尝试五次，退避为 10/20/40/40 毫秒。安全操作通过进程内 Node-API Win32 绑定执行，不需提权，绝不启动或回退 PowerShell。不缓存身份、ACL 或路径结果：每次读取既有文件均重新合并核验文件与私有目录的 ACL、属主 SID，并完整遍历祖先重解析点。只读句柄在核验前打开；读取任何字节前，将其身份与打开前及核验后的路径名元数据比对。缺失文件仍须核验目录。部署者须防止非受信方并发替换祖先；路径名元数据不是绑定句柄的 Windows 安全检查。应实测部署延迟后再选择互不重叠的探测周期；进程启动时间不是网络健康期限。

Windows 策略拒绝错误提供稳定的 `code`；`WINDOWS_PRIVATE_FILE_CODES` 将不变的英文错误消息映射为代码，`WindowsPrivateFileCode` 为对应联合类型。这些代码不包含路径或凭据。消费者负责本地化修法；策略消息与检查顺序不变。

| 代码 | 英文消息 |
| --- | --- |
| `private-absolute-path` | Private absolute Windows path rejected |
| `private-filename` | Private filename rejected |
| `private-reparse-point` | Private reparse point rejected |
| `private-parent-path` | Private parent path rejected |
| `private-owner-sid` | Private owner SID rejected |
| `private-acl-inheritance` | Private ACL inheritance rejected |
| `private-acl-entry-count` | Private ACL entry count rejected |
| `private-acl-sid` | Private ACL SID rejected |
| `private-acl-rights` | Private ACL rights rejected |
| `private-directory-type` | Private directory type rejected |
| `private-file-type-or-links` | Private file type or links rejected |
| `private-file-exceeds-limit` | Private file exceeds limit |
| `private-file-identity` | Private file identity rejected |

宿主创建 `credential` 与 `endpoint.json`，退出删除两者；每次启动生成独立进程代次。凭据仅通过私有文件和认证头传递，不进入参数、地址、环境变量或操作记录。`callAdmin` 只连接已运行宿主，缺少端点时拒绝，不自动启动服务。

`hostAdminExecutor` 接收传输导出的身份并保留原引擎检查。没有自定义执行器时，运行时从现有引擎的签发器、事务及查询能力装配 `createHostAdminExecutor`。监听器持有的身份签发 `local-operator` 归属，与队列批准原子提交。自报 dispatch 身份不能进入此路径或读取缓存回执；缺少能力时拒绝该方法。状态及待批准查询保留只读引擎回退。

`hostSessionCredentials` 在会话专属权限目录中签发独立且绑定进程代次的凭据。受信创建方提供会话与位，已有核验员工号时可一并提供；请求字段不提供身份。替换或撤销绑定会删除凭据并取消其调用信号。运维 SDK 调用没有位，命名空间授权必须拒绝无位写入。会话凭据不能调用管理方法。`callHostSdk` 读取显式端点与凭据路径，只发送一次，不重试未知结果。

`source.operations({ limit? })` 读取可选 `hostAdminSourceOperator.list` 提供方，原样返回条目；`limit` 为 1 至 200 的整数。`source.abandon` 和 `source.resend` 接受 `{ operationId, key, reason }`，要求本地操作员身份及签发器允许的授权，并核对节点、主体、操作号和请求摘要。提供方收到原始授权，负责审计、释放和重发语义。`key` 长度为 1–512 个字符，`reason` 为 1–500；未知字段拒绝。结果最多包含 200 条 `awaiting-manual` 或 `parked-none` 项，字符串有界、时刻为 ISO 格式；写结果为 `ok` 或 `rejected`，可带正整数代次。缺少提供方或可选 `resend` 时返回 `unavailable` 和 `admin-method-unavailable`。该服务不列为注入依赖。`callAdmin` 及其 SDK 导出 `callHostAdmin` 只使用操作员通道；`sdk.invoke` 与会话凭据不增加来源方法。

`readNodeHealth(ctx, limit)` 仅聚合已安装的本机引擎、对端健康及来源操作员提供方。本机身份来自引擎节点标识，未知对端容量保持 null。回调行来自可选实时 `callbackObservations`，先筛停车态再限条数，不从持久重试投影推断。行内不含冻结回调正文或凭据。来源可选 `observation` 携带安全停车码、尝试次数及可空的真实尝试时刻；缺失历史时刻保持 null。浏览器消费方通过纯类型 `/types` 入口导入观察数据。`executeNodeOperator` 要求捕获的本地操作员身份，复用运行中引擎既有执行器与授权核验，不安装监听器。`decodeHostAdminRequest` 为经过认证的适配器提供既有请求校验。`node.rebuild` 的可选 `peerNodeId` 选择本宿主已配置的出站对端；`{}` 保留旧行为。

<a id="persistence-and-recovery"></a>
## 持久化与恢复

`operations.json` 按主体与操作号保留摘要、待决状态或原始回执。先耐久写待决再执行，结果落盘后才公开；同号同参返回原结果，异参拒绝。来源拒绝明确声明 `effect: 'none'` 时保留 `retryable` 指纹而不固化终态回执，允许同一授权请求重试，但不允许改变参数。丢回包保持未知，不自动重放。容量耗尽拒绝新操作，不淘汰未知记录。此接收记录不替代引擎授权账本。旧读取器拒绝 `retryable` 记录；回退前停止准入并保存完整存储供兼容读取器使用，不得删记录强行启动。

已登记提供方失败只公开 `detail: 'source-settlement-pending'` 或 `detail: 'write-budget-exceeded-before-write'`，不返回任意异常文本。来源写拒绝的 `effect: 'none'` 表示提供方未开始操作的持久写，不表示结果未知。`node.rebuild({})` 调用宿主持有的可选链路能力，不启动另一宿主；缺少能力时返回不可用。重拉子进程后仍须通过原有对端认证握手才能路由。

`engine.cancel({ operationId, queueItemId, expectedStateVersion, reason? })` 要求本地操作员授权绑定配置节点、主体、操作号与请求摘要，调用运行中引擎的授权取消能力；节点委托及会话凭据不能取消。可选原因最多 512 个 UTF-8 字节且不能含控制字符。取消与签发的操作员归属同次提交至引擎账本。`engine.operation` 返回已结算取消回执，包含谁、何时、哪项、原因和结果；脱敏查询只公开原因是否存在。未知、已派发和已开窗目标保留 `revision-conflict` 并增加结构化 `cause.reasonCode`；过期版本保留原拒绝结果。传输回执仍支持重启后回放及丢回包时的未知结果；取消不增加远程入口。

`engine.operation({ operationId })` 读取引擎账本而非传输回执：`approval` 表示队列批准登记，`progress` 区分待决理由与阻塞项、关联开窗阶段及取消。已创建窗口与首轮失败在重启后仍可区分。查询不驱动或重放工作。

`engine.query({ limit, taskId?, seat?, kind?, cursor?, authorizationCursor? })` 返回脱正文的 `effects` 和来自已签发事实投影的独立 `authorizations` 分页，包括 `plugin` 与 `local-operator` 种类。每页各有 `complete`、`watermark`、`nextCursor`；效果使用 `cursor` 续查，授权使用 `authorizationCursor` 续查。条数上限分别应用于两页，完整响应仍受字节上限限制。冻结指令与原始来源数据被省略，不提供原文查询选项。

正常卸载及 `SIGINT`/`SIGTERM` 排空自有资源；即使前序清理失败，仍尝试删除凭据、端点和锁。同一幂等释放函数撤销终止监听；强杀无法执行清理。进程退出仍由部署的进程监管方负责。

`reportHostFailure` 将固定短句的一行 error 追加到 `~/.panedesk/logs/host-errors.log` 并写 stderr。仅保留显式白名单细因码，不格式化异常消息、堆栈、路径或 URL。追加失败另写一行固定 stderr 提示。该助手不安装 boot 致命出口。

Windows 验收：在 Windows 构建原生 addon 后，从仓库根运行 `pnpm exec tsx packages/host/host-admin/tests/windows-private-files-native.mts`。它检查真实私有文件操作、硬链接与 junction 拒绝、锁互斥和释放及二十次替换写入；输出中位数与 P95 毫秒值，目标分别为 3000/5000 毫秒。Linux 对照测试不能证明 Windows 实跑或耗时。

`owner.lock` 保证单个目录仅有一个运行实例；进程异常退出后的遗留锁需运维确认旧实例已退出后显式恢复，插件不凭 PID 猜测接管。

<a id="callback-resolution"></a>
### 回调处置

`engine.callbackResolve({ callbackId, action: 'resume' | 'abandon', expectedAttempt })` 只接受认证的 `local-operator`，节点、主体和精确请求授权核验同取消。运行中引擎将一条 `callback/attempted` 转换与操作员授权同帧提交。resume 保留 attempt 和原正文，进入 `retry-due` 并起算新保留段；abandon 进入终态 `abandoned`。只有同回调标识、同动作、同预期 attempt 的处置帧之后没有新停车帧时，才读回现状、零帧重放，重启后亦然。否则先拒非 paused，再比较 attempt；相同 attempt 上的新停车允许再次处置。未知回调、非 paused 及 attempt 不符分别返回 `callback-unknown`、`callback-not-paused`、`callback-attempt-conflict`；无效授权返回 `admin-unauthorized` 或 `callback-resolution-unauthorized`。传输结果不明返回 `uncertain / admin-outcome-unknown`，不自动重试。

通过 `engine.query` 读取固定本机诊断 `callback-unclassified-error`、`callback-timeout`、`callback-authentication-failed`、`callback-protocol-error`，不含异常原文。引擎内建 900000 ms 上限从当前连续 transient 段首个已提交 attempted 帧起算，重启和暂态细码变化不重置。停车后至处置前，该回调不再落帧。`callback-link-unreachable-limit` 在更新的 hello 就绪时每次停车自动恢复一次，码为 `callback-auto-resumed-on-link-ready`；`callback-transient-limit-reached` 要求操作员。同组 `(sourceId, sessionId, triggerId)` 中，ended 等待 paused opened；resume 后等前项 delivered，abandon 后下一轮放行。完整计时和 unknown 屏障规则见[引擎说明](../../seat/seat-engine/README.zh.md#callback-parking-and-operator-resolution)。

操作员命令行会话使用已配置并完成权限校验的 `files` 提供方和 `limits`；以下调用不启动第二个宿主，也不在参数中传入口令：

```js
const { callHostAdmin } = await import('@panedesk/dsh-host-admin');
const result = await callHostAdmin(files, 'engine.callbackResolve', {
  callbackId, action: 'abandon', expectedAttempt,
}, limits);
console.log(result);
```

修复前提后，用 `action: 'resume'` 续投原回调。选择动作前，先从完整查询结果取得 `callbackId` 和当前 `attempt`。

<a id="model-experience"></a>
## 模型体验

### 管理请求

#### 模型可见内容

`hostAdminExecutor` 不注入工具、提示词或会话内容；管理结果由调用方接收。批准回执不等于开窗完成。

#### 词元影响

通道本身不产生模型请求或词元消耗。

#### KV 缓存影响

不修改历史会话及缓存前缀。

## 已知限制与待完成项

<a id="known-limitations-and-deferred-work"></a>

- M8b：回调 abandon 不改 `chain-sent`，也不生成 owner 终态回执；既有链层恢复保持独立。
- 取消要求引擎提供可选的授权取消能力；能力缺失时拒绝，不调用无授权旧入口。外部改面占位释放仍归其提供方，不由运维传输实现。
- `engine.operation` 要求引擎提供可选操作投影；旧提供方缺少此能力时仍不可用。已接纳意图若无已提交创建或失败事实，保持待决，不能报告成功。旧自定义执行器可省略授权分页；调用者不能将缺页当成空授权历史。

- Windows ACL 实跑、真实 SSH 与多进程崩溃注入不在本包 Linux 替身测试覆盖内。执行提供器必须保证自身调用可终止；卸载会等待已接纳调用，不能强制取消任意提供器内部副作用。nonce 集合和操作记录有显式容量限制，满额后需受控重启或运维处理。

撤销会删除凭据文件，但保留空的属主私有会话目录。长期运行的部署需在宿主停机维护期间清理空目录；私有文件策略目前不负责目录回收。

<a id="dev-note"></a>
### 开发备注

Keep administration behind the existing host and executor authority; do not start a second engine.
