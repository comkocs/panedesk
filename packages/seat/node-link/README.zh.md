---
description: "Explicit authenticated transport between one configured node pair."
kind: "package-reference"
---

# `@panedesk/dsh-node-link`

[English](README.md) | 中文

## 概述

可选节点传输，通过受监管 OpenSSH 子进程建立双向回环转发，复用既有主机别名与严格主机钥匙校验，不创建 SSH 密钥或远程命令。省略 `runtime` 时不创建监听、进程或路由服务。

## 目录

- [用途](#purpose)
- [配置与身份](#configuration-and-identity)
- [持久化与断链](#persistence-and-disconnection)
- [模型体验](#model-experience)
- [已知限制与待完成项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="purpose"></a>
## 用途

固定方法为 `seat.open`、`seat.openBatch`、`seat.renew`、`seat.close`、`seat.replace`、`seat.wake`、`messages.send`、`seat.operation`。完整请求校验版本、来源、目标、操作号、期限、摘要与单跳委托；回包校验所有关联身份。接收端只能调用本地执行适配，不再转发。

可选 `messages.sendSeat` 携带一个精确 `{ nodeId, seat }` 和冻结投递信封；`messages.onlineSeats` 只携带操作身份。两者要求对端通告 `seat-messages/v1`，且逐方法显式委托授权。本地执行前核验认证节点对、原发送会话及完整载荷摘要。未知位发送先查原回执，只有认证的 `missing` 才允许再次发送原载荷。在线查询不写意图存储、不预留窗口；缺少收件器或授权能力时拒绝，不扩权。启用前两节点一同升级；旧闭集读取器不能读新方法记录，回退前须通过兼容读取器保留未决存储。

<a id="configuration-and-identity"></a>
## 配置与身份

`runtime` 必须填写 `nodeId`、`peerNodeId`、`peerName`、`directory`、`listenPort`、`peerPort`、`maxFrameBytes`、`requestTimeoutMs`、`maxPending`、`maxStoreBytes`、`maxOperations`、`staleMs`。`listenPort: 0` 供临时随机端口测试，`peerPort` 指向本机受监管转发或替身对端。

可选 `runtime.forwardedHosts` 是转发入口 `host:port` authority 的精确名单。主机须为 IPv4 回环标准字面量、`localhost` 或 IPv6 回环方括号字面量，端口须为显式规范十进制数，范围 1 至 65535；通配、范围、缺端口与其他主机均在配置校验期报错。每个接收节点填写配对发送端在转发入口实际使用的 Host；主机别名不互换。省略或空表仅接受原监听 authority。认证、浏览器请求头拒绝和 admin 端点保持不变。

node-link 每次 Host 拒绝记录一行 `host-mismatch`，只含 `expectedPort`（接收端监听端口）和 `actualPort`（Host 端口；非法时 JSON 为 `null`，日志为 `unknown`）。其他接纳条件全部通过且帧限额允许时，HTTP 403 hello 回包包含这三个字段。发送端仅将白名单码 `host-mismatch` 投影到 `safeReason`，不公开地址或凭据，也不把拒绝视为已认证的对端健康证据。其他拒绝回包保留泛化传输失败。

可选 `ssh` 必须填写 `alias`、`cwd`、`remotePort`、`remoteTargetPort`、`graceMs`、`keepAliveSeconds`、`keepAliveCount`、`retryMs`、`maxRetries`，并要求已有 `subprocess` 服务。可选 `sshConfigFile` 作为单个 `-F` 参数值传入；省略时保持 OpenSSH 原有配置选择。路径须非空、最多4096字符、无控制字符且不以 `-` 开头。别名必须是简单名称，禁止命令或任意选项。转发两端显式绑定回环；私有 SSH 配置必须经过运维审核，不得附带额外转发或改变认证身份。

每节点预置 `inbound.json` 与 `outbound.json`，均含方向节点标识、`epoch` 与随机凭据；两个方向值必须独立。`provisionInbound` 可生成入向私有文件但不打印或返回秘密值。将一端入向文件安全配置为另一端出向文件，禁止通过参数、地址或环境变量传播。

POSIX 目标目录为当前属主的 `0700` 绝对路径，文件为 `0600` 单硬链接普通文件，路径不得含符号链接；运维须保证祖先目录不受非受信账号替换。Windows 显式注入 `nodeLinkFiles: directory => new WindowsPrivateFiles(directory)`，类从 `@panedesk/dsh-host-admin` 导出；POSIX 默认装配不变。Windows 启动最多等待 `requestTimeoutMs`，直到工厂提供者活动；不回退 POSIX，工厂缺失或文件失败进入 Cordis 启动错误链。启动期间组合变化会取消旧附着，不在其失活上下文上发布服务；初始启动等待替代附着完成并传播其失败。其 [Windows 存储策略](../../host/host-admin/README.zh.md#configuration-and-identity) 拒绝继承项、额外 SID 和重解析点，空文件先设权限再写内容，刷盘后替换并对共享冲突作有界重试。健康重载使用新鲜的进程内 Win32 元数据检查，不启动 PowerShell、不缓存 ACL；`staleMs` 应计入实测开销。每次健康探测重新读取两个方向的已校验私有文件。`credentialOverlapMs` 显式限制唯一旧代次的剩余有效期，省略则禁用重叠。发布新凭据时附带具有固定 `expiresAt` 的旧条目，再安全更新对端出向文件；重叠期两个代次均可认证，到期后拒绝旧代次。重载失败会断开出向路由；发布须与探测周期协调。

`createDelegationIssuer` 捕获受信签发证据，将到期限制在原授权和请求期限内。`createDelegationReceivingPolicy` 验证留存证据，并依真实对端的本地权限白名单收窄。`createNodeLinkExecutor` 在执行前复核授权；席位写操作要求 `localAdmission` 将授权与意图一起提交，远端消息要求宿主持有的精确载荷授权。委托字符串或 SSH 登录本身不赋予权限。未显式提供执行器时，已配置传输仅在接收策略、授权事务、本地席位及 `nodeAuthorizedLocalAdmission` 服务全部安装后组合它们。缺少服务时拒绝接收，接收端不再转发。后备装配通过 `ctx.get` 读取可选的 `routedMessageReceiver` 与 `nodeMessageAuthority` 服务；消息能力缺失时保持原有拒绝。

可选 `nodeMessageEvidence` 向经过认证的配对节点提供独立留存的消息授权。传输为接收策略发布 `nodeMessageEvidenceRemote`，仅接受精确的 `messages.sendSeat` 或 `messages.onlineSeats` 证据查询；调用方不能选择其他端点或方向。新增的 `message-delegation-evidence` 控制帧使用既有方向凭据、完整帧限制和关联请求号。控制入口具有与消息执行分离的预留容量，未组合工作链时也如此；已接纳的派发在传输存储关闭前排空。旧帧仍可读取；只有双方均支持该证据帧后才能启用此宿主策略，旧对端会安全拒绝查询。

Windows 等证据持久化较慢的节点，席位引擎的 `callbackTimeoutMs` 必须覆盖证据落盘耗时（一次部署实测约 1.2 秒）及其余回调工作耗时。

<a id="persistence-and-disconnection"></a>
## 持久化与断链

`received/operations.json` 在执行前耐久记录待决，`sent/operations.json` 保留发送身份与结果。同号同参不重复执行，同号异参拒绝；丢回包标未知，通过认证只读回执恢复，不盲重发。存在未决发送时阻止新的写操作，容量满时拒绝而不淘汰。根目录 `owner.lock` 排斥双实例，遗留锁需人工确认后恢复。正常卸载及 `SIGINT`/`SIGTERM` 共用幂等释放：排空探测、链、隧道、监听器和存储，即使前序清理失败仍尝试释放锁；释放时撤销信号监听。强杀不能清理，进程退出仍由监管方负责。

工作链在证据与意图落盘后、触网前重新核对请求与委托期限。过期返回 `deadline-exceeded`，不触网、不撤连接；已接纳意图持久保留 `effectState: 'none'`。仅回执投递可恢复此传输回执。发送前期限耗尽及对端能力暂缺，仅对回调投递与原键精确查询明确标记可重试；身份、授权及发起类方法拒绝保留既有分类。发起类方法在发送前被拒后保持终拒，链路恢复后不自动发送。

断链先于能力协商拒绝新请求。工作链在 TCP 连接建立前失败时，返回 `node-tunnel-disconnected` 与 `effectState: 'none'`，将已接纳的发送意图持久落定，并撤销连接观察与对端能力。经过授权的精确 `chain.operation` 查询即使在断链时也能读回该本地拒绝；它不是推断出的业务证据。TCP 连接建立后丢失响应仍为未知，发送记录保持待决；经过认证的精确查询核对恢复后的业务结果，不重复执行。已发送但无回包不能声称未执行。健康探测校验代次与节点自报身份；超 `staleMs` 标为过期，保留上次窗数，不伪造零窗。SSH 进程存活不等于应用握手成功。

隧道启动、退出、重拉、耗尽与监督异常通过宿主日志记录；stderr 只保留去地址的末尾摘要，最多五行、每行 200 字节、总计 1 KB。原始 stderr 缓冲限于 4 KB；stdout 丢弃。子进程存活至少 `retryMs` 后，下次重拉前清零计数；更短存活的子进程消耗有界的 `maxRetries` 预算，每次重拉均等待 `retryMs`。耗尽后，`nodeRouter.status()` 与节点查询通过 `safeReason` 显示末次退出原因。经过认证的 admin `node.rebuild` 方法只替换自有隧道，恢复有界监督、stderr 捕获及重试预算；并发重拉合并为一次替换。替换前取消旧重试，释放不能重启子进程。宿主及方向凭据不变。常规认证 hello 成功前路由仍断开；子进程创建本身不表示链路恢复。

<a id="model-experience"></a>
## 模型体验

### 节点请求

#### 模型可见内容

`nodeLinkExecutor` 不新增工具或提示词；只传递既有方法请求和结果。接纳回执不代表模型已执行完成。

#### 词元影响

传输不额外调用模型，实际词元消耗由原本地操作决定。

#### KV 缓存影响

不改变会话历史或缓存前缀。

## 已知限制与待完成项

显式 `nodeWorkChain` 组合启用 `node-work-chain/v1`、七个固定方法与精确 `delegation-evidence` 帧。hello 仅在业务提供方、本地准入、接收策略和持久证据全部恢复后通告接收能力；提供方撤销即撤去能力。晚装或替换 `nodeWorkChain` 时，先排空旧传输再重挂载；卸载不等待就绪永不完成的注入证据提供方。完整 JSON 帧包含委托、冻结输入和结果外壳；采用本地与双方协商限额的最小值，上限为 1,048,576 个 UTF-8 字节，不截断、不分片。诊断码最多 128 个 ASCII 字符，说明最多 512 个 UTF-8 字节。控制请求具有独立有界容量。经过鉴权的 `chain.operation` 调用查询已恢复的业务所有者，不从传输收据推断缺失。

可选 `seat.definitionRevision` 要求双方通过独立 hello 字段 `seatDefinitionRevision: 'seat-definition-revision/v1'` 通告能力；`chain.methods` 仍是原七方法闭集。任何一方缺能力均在发送前拒绝。显式 `local.methods` 与 `local.definitionRevisions` 必须提供已就绪且可用的提供方；撤装立即移除此能力。接收政策必须核精确读与目标席权限，以及受信来源所有权和代次，再独立签发精确凭证。读使用普通业务容量，但不进入意图存储、业务查询或发件箱重放，只保留有界授权证据。首次准备前读；恢复已持久准备及原版本／摘要，不在同键下重读。观察与准入不具原子性，版本变化时安全拒绝，不透明刷新。两节点须成对升级。写过新方法授权证据后，旧程序的闭集 decoder 不能读取这些记录。回滚前须停用新读，并通过兼容 reader 或隔离存储保留记录，不得删除记录让旧程序启动。

`route(request, authorization)` 要求与委托逐字段一致的新入口授权。发送前，node-link 将事实持久留存在有界的 `chain-evidence/evidence-v1.json`；仅已认证配对节点可以精确查询，到期证据在恢复或发布时淘汰。独立的 `chain-received/chain-v1.json` 与 `chain-sent/chain-v1.json` 保留完整原意图与精确业务键，不淘汰未决记录。待决与未知结果不成为终态；不重开所有者暂停与拒绝。可选的宿主持有 `outboxIssuer` 仅在已认证业务查询答复缺失后，允许使用持久原载荷、原键及新签发受限授权经原方法重发。缺少该签发器时，未决发送保留未知；不调用 `resume`。未配置链组合时不打开这些文件。

启动就绪、在线 hello 与重连均扫描所有已接纳方法的无响应未决意图。发送端合成的无副作用 `node-deadline-exceeded` 或 `node-tunnel-disconnected` 回执仅在原方法为 `source.deliverCallback` 时可恢复，无元数据的旧记录同样适用。发起类方法（`engine.acceptFrozen`、`seat.openFrozen`、`seat.wakeFrozen`、`source.prepareOpening`）在断链或触网前被拒后保持终拒；恢复不自动发送，精确查询即使在线也保留已接纳条目的本地原拒绝。无响应的发中断仍照原键查证。恢复先获取新受限授权，再精确查询已恢复的所有者。只有经过认证的持久 `missing` 才允许使用新 wire 请求号经原方法续投一次；业务键、载荷摘要与冻结路由不变。未知、超时、断链、能力不可用或授权被拒均不能许可续投。所有者已提交的证据仅修复回执，不再发送。同键发送与恢复串行；再次超期等待下一次恢复触发，不循环热投。所有者拒绝不会成为传输重投候选，seat 发件箱未知屏障保持不变。

`chain-sent` 可选内部字段 `transportNone` 与 `recovery` 区分发送端拒绝和所有者响应，并保留 `attemptId` 及含每次旧 `response`、`reactivatedAt` 的 `history`。重新激活在发布前比较原键、摘要与观察到的旧回执；旧尝试不能结清已重新激活的条目。历史计入既有存储字节限额，不丢弃历史腾出空间。新版直接读取旧记录；旧版拒绝含这些可选字段的记录。回滚前须通过兼容 reader 或隔离存储保留记录，不得删除回执或历史让旧程序启动。

<a id="known-limitations-and-deferred-work"></a>

- 显式 `nodeLinkExecutor` 提供方优先。否则，已配置运行时组合接收策略、授权事务、本地席位与 `nodeAuthorizedLocalAdmission`；缺少服务时拒绝入站。本地提供方支持带审计的开窗、续期、替换和关闭，带审计的改名与唤醒仍不可用。Loader 组合测试证明开窗与替换成功，不代表六类方法或生产消息投递全部验收。Windows 实跑与真实 SSH 验收未执行。只支持一对配置节点，未提供多节点路由注册与热配置轮换。

- 业务执行适配须保证调用可收敛；卸载等待已接纳操作。持久存储为有限容量完整文件，未实现日志压缩、自动清理或遗留锁自动接管。凭据文件与发送接收记录不能作为引擎授权真源。

<a id="dev-note"></a>
### 开发备注

Keep transport separate from execution authority; missing local executors must reject incoming operations.
