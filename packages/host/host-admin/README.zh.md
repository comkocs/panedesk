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

五个管理方法为 `node.status`、`engine.pending`、`engine.approve`、`engine.operation`、`engine.query`。新增的 `sdk.invoke` 只向已注册 SDK 命名空间分派，依次走其解码、授权、执行和编码函数；未注册或已卸载的命名空间返回 `method-unavailable`。传输限定本机回环，拒绝浏览器来源、请求 cookie、非固定路径、错误 Host、旧进程代次及错误认证头。请求与响应均受完整帧字节上限约束。

<a id="configuration-and-identity"></a>
## 配置与身份

`runtime` 必须显式填写 `directory`、`nodeId`、`principalId`、`port`、`maxFrameBytes`、`requestTimeoutMs`、`maxPending`、`maxStoreBytes`、`maxOperations`。测试使用 `port: 0` 分配临时端口；部署端口由配置决定。配置经 Loader 装配，入口无命令行启动能力。

`directory` 为独占绝对路径，POSIX 目录权限必须为 `0700`，文件必须为当前属主的单硬链接普通文件且权限为 `0600`。祖先路径不得含符号链接；部署者还须保证祖先目录不可被非受信账号替换。Windows 必须提供 `hostAdminFiles`，负责等效 ACL、路径及原子耐久写入校验。

宿主创建 `credential` 与 `endpoint.json`，退出删除两者；每次启动生成独立进程代次。凭据仅通过私有文件和认证头传递，不进入参数、地址、环境变量或操作记录。`callAdmin` 只连接已运行宿主，缺少端点时拒绝，不自动启动服务。

`hostAdminExecutor` 接收传输导出的身份并保留原引擎检查。没有自定义执行器时，运行时从现有引擎的签发器、事务及查询能力装配 `createHostAdminExecutor`。监听器持有的身份签发 `local-operator` 归属，与队列批准原子提交。自报 dispatch 身份不能进入此路径或读取缓存回执；缺少能力时拒绝该方法。状态及待批准查询保留只读引擎回退。

`hostSessionCredentials` 在会话专属权限目录中签发独立且绑定进程代次的凭据。受信创建方提供会话与位，已有核验员工号时可一并提供；请求字段不提供身份。替换或撤销绑定会删除凭据并取消其调用信号。运维 SDK 调用没有位，命名空间授权必须拒绝无位写入。会话凭据不能调用五个运维方法。`callHostSdk` 读取显式端点与凭据路径，只发送一次，不重试未知结果。

<a id="persistence-and-recovery"></a>
## 持久化与恢复

`operations.json` 按主体与操作号保留摘要、待决状态或原始回执。先耐久写待决再执行，结果落盘后才公开；同号同参返回原结果，异参拒绝，丢回包保持未知，不自动重放。容量耗尽拒绝新操作，不淘汰未知记录。此接收记录不替代引擎授权账本。

`engine.operation({ operationId })` 读取引擎账本而非传输回执：`approval` 表示队列批准登记，`progress` 区分待决理由与阻塞项、关联开窗阶段及取消。已创建窗口与首轮失败在重启后仍可区分。查询不驱动或重放工作。

`engine.query({ limit, taskId?, seat?, kind?, cursor?, authorizationCursor? })` 返回脱正文的 `effects` 和来自已签发事实投影的独立 `authorizations` 分页，包括 `plugin` 与 `local-operator` 种类。每页各有 `complete`、`watermark`、`nextCursor`；效果使用 `cursor` 续查，授权使用 `authorizationCursor` 续查。条数上限分别应用于两页，完整响应仍受字节上限限制。冻结指令与原始来源数据被省略，不提供原文查询选项。

`owner.lock` 保证单个目录仅有一个运行实例；进程异常退出后的遗留锁需运维确认旧实例已退出后显式恢复，插件不凭 PID 猜测接管。

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

- `engine.operation` 要求引擎提供可选操作投影；旧提供方缺少此能力时仍不可用。已接纳意图若无已提交创建或失败事实，保持待决，不能报告成功。旧自定义执行器可省略授权分页；调用者不能将缺页当成空授权历史。

- Windows ACL 实跑、真实 SSH 与多进程崩溃注入不在本包 Linux 替身测试覆盖内。执行提供器必须保证自身调用可终止；卸载会等待已接纳调用，不能强制取消任意提供器内部副作用。nonce 集合和操作记录有显式容量限制，满额后需受控重启或运维处理。

撤销会删除凭据文件，但保留空的属主私有会话目录。长期运行的部署需在宿主停机维护期间清理空目录；私有文件策略目前不负责目录回收。

<a id="dev-note"></a>
### 开发备注

Keep administration behind the existing host and executor authority; do not start a second engine.
