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

<a id="configuration-and-identity"></a>
## 配置与身份

`runtime` 必须填写 `nodeId`、`peerNodeId`、`peerName`、`directory`、`listenPort`、`peerPort`、`maxFrameBytes`、`requestTimeoutMs`、`maxPending`、`maxStoreBytes`、`maxOperations`、`staleMs`。`listenPort: 0` 供临时随机端口测试，`peerPort` 指向本机受监管转发或替身对端。

可选 `ssh` 必须填写 `alias`、`cwd`、`remotePort`、`remoteTargetPort`、`graceMs`、`keepAliveSeconds`、`keepAliveCount`、`retryMs`、`maxRetries`，并要求已有 `subprocess` 服务。别名必须是简单名称，禁止命令或任意选项。转发两端显式绑定回环；私有 SSH 配置必须经过运维审核，不得附带额外转发或改变认证身份。

每节点预置 `inbound.json` 与 `outbound.json`，均含方向节点标识、`epoch` 与随机凭据；两个方向值必须独立。`provisionInbound` 可生成入向私有文件但不打印或返回秘密值。将一端入向文件安全配置为另一端出向文件，禁止通过参数、地址或环境变量传播。

POSIX 目标目录为当前属主的 `0700` 绝对路径，文件为 `0600` 单硬链接普通文件，路径不得含符号链接；运维须保证祖先目录不受非受信账号替换。Windows 显式注入 `nodeLinkFiles: directory => new WindowsPrivateFiles(directory)`，类从 `@panedesk/dsh-host-admin` 导出；默认装配不变。其 [Windows 存储策略](../../host/host-admin/README.zh.md#configuration-and-identity) 拒绝继承项、额外 SID 和重解析点，空文件先设权限再写内容，刷盘后替换并对共享冲突作有界重试。一次双向健康重载启动八个仅输出元数据的 PowerShell 进程，不缓存 ACL；`staleMs` 应计入实测开销。每次健康探测重新读取两个方向的已校验私有文件。`credentialOverlapMs` 显式限制唯一旧代次的剩余有效期，省略则禁用重叠。发布新凭据时附带具有固定 `expiresAt` 的旧条目，再安全更新对端出向文件；重叠期两个代次均可认证，到期后拒绝旧代次。重载失败会断开出向路由；发布须与探测周期协调。

`createDelegationIssuer` 捕获受信签发证据，将到期限制在原授权和请求期限内。`createDelegationReceivingPolicy` 验证留存证据，并依真实对端的本地权限白名单收窄。`createNodeLinkExecutor` 在执行前复核授权；席位写操作要求 `localAdmission` 将授权与意图一起提交，远端消息要求宿主持有的精确载荷授权。委托字符串或 SSH 登录本身不赋予权限。未显式提供执行器时，已配置传输仅在接收策略、授权事务、本地席位及 `nodeAuthorizedLocalAdmission` 服务全部安装后组合它们。缺少服务时拒绝接收，接收端不再转发。后备装配通过 `ctx.get` 读取可选的 `routedMessageReceiver` 与 `nodeMessageAuthority` 服务；消息能力缺失时保持原有拒绝。

<a id="persistence-and-disconnection"></a>
## 持久化与断链

`received/operations.json` 在执行前耐久记录待决，`sent/operations.json` 保留发送身份与结果。同号同参不重复执行，同号异参拒绝；丢回包标未知，通过认证只读回执恢复，不盲重发。存在未决发送时阻止新的写操作，容量满时拒绝而不淘汰。根目录 `owner.lock` 排斥双实例，遗留锁需人工确认后恢复。

断链拒绝新请求，已发送但无回包不能声称未执行。健康探测校验代次与节点自报身份；超 `staleMs` 标为过期，保留上次窗数，不伪造零窗。SSH 进程存活不等于应用握手成功。

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

显式 `nodeWorkChain` 组合启用 `node-work-chain/v1`、七个固定方法与精确 `delegation-evidence` 帧。hello 仅在业务提供方、本地准入、接收策略和持久证据全部恢复后通告接收能力；提供方撤销即撤去能力。完整 JSON 帧包含委托、冻结输入和结果外壳；采用本地与双方协商限额的最小值，上限为 1,048,576 个 UTF-8 字节，不截断、不分片。诊断码最多 128 个 ASCII 字符，说明最多 512 个 UTF-8 字节。控制请求具有独立有界容量。经过鉴权的 `chain.operation` 调用查询已恢复的业务所有者，不从传输收据推断缺失。

`route(request, authorization)` 要求与委托逐字段一致的新入口授权。发送前，node-link 将事实持久留存在有界的 `chain-evidence/evidence-v1.json`；仅已认证配对节点可以精确查询，到期证据在恢复或发布时淘汰。独立的 `chain-received/chain-v1.json` 与 `chain-sent/chain-v1.json` 保留完整原意图与精确业务键，不淘汰未决记录。待决、未知及暂停结果不成为终态。可选的宿主持有 `outboxIssuer` 仅在已认证业务查询答复缺失后，允许使用持久原载荷、原键及新签发受限授权经原方法重发。缺少该签发器时，未决发送保留未知；不调用 `resume`。未配置链组合时不打开这些文件。

<a id="known-limitations-and-deferred-work"></a>

- 显式 `nodeLinkExecutor` 提供方优先。否则，已配置运行时组合接收策略、授权事务、本地席位与 `nodeAuthorizedLocalAdmission`；缺少服务时拒绝入站。本地提供方支持带审计的开窗、续期、替换和关闭，带审计的改名与唤醒仍不可用。Loader 组合测试证明开窗与替换成功，不代表六类方法或生产消息投递全部验收。Windows 实跑与真实 SSH 验收未执行。只支持一对配置节点，未提供多节点路由注册与热配置轮换。

- 业务执行适配须保证调用可收敛；卸载等待已接纳操作。持久存储为有限容量完整文件，未实现日志压缩、自动清理或遗留锁自动接管。凭据文件与发送接收记录不能作为引擎授权真源。

<a id="dev-note"></a>
### 开发备注

Keep transport separate from execution authority; missing local executors must reject incoming operations.
