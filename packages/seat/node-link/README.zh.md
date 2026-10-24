# `@panedesk/dsh-node-link`

[English](README.md) | 中文

可选节点传输，通过受监管 OpenSSH 子进程建立双向回环转发，复用既有主机别名与严格主机钥匙校验，不创建 SSH 密钥或远程命令。省略 `runtime` 时不创建监听、进程或路由服务。

## 用途

固定方法为 `seat.open`、`seat.openBatch`、`seat.renew`、`seat.close`、`seat.replace`、`seat.wake`、`messages.send`、`seat.operation`。完整请求校验版本、来源、目标、操作号、期限、摘要与单跳委托；回包校验所有关联身份。接收端只能调用本地执行适配，不再转发。

## 配置与身份

`runtime` 必须填写 `nodeId`、`peerNodeId`、`peerName`、`directory`、`listenPort`、`peerPort`、`maxFrameBytes`、`requestTimeoutMs`、`maxPending`、`maxStoreBytes`、`maxOperations`、`staleMs`。`listenPort: 0` 供临时随机端口测试，`peerPort` 指向本机受监管转发或替身对端。

可选 `ssh` 必须填写 `alias`、`cwd`、`remotePort`、`remoteTargetPort`、`graceMs`、`keepAliveSeconds`、`keepAliveCount`、`retryMs`、`maxRetries`，并要求已有 `subprocess` 服务。别名必须是简单名称，禁止命令或任意选项。转发两端显式绑定回环；私有 SSH 配置必须经过运维审核，不得附带额外转发或改变认证身份。

每节点预置 `inbound.json` 与 `outbound.json`，均含方向节点标识、`epoch` 与随机凭据；两个方向值必须独立。`provisionInbound` 可生成入向私有文件但不打印或返回秘密值。将一端入向文件安全配置为另一端出向文件，禁止通过参数、地址或环境变量传播。

POSIX 目标目录为当前属主的 `0700` 绝对路径，文件为 `0600` 单硬链接普通文件，路径不得含符号链接；运维须保证祖先目录不受非受信账号替换。Windows 必须提供 `nodeLinkFiles` 实现等效 ACL 与耐久写入。运行中凭据保存在内存快照，轮换须协调两端卸载、重新配置并装载；本版不实现热轮换或短重叠。

`nodeLinkExecutor` 必须验证真实主体、当前绑定、目标及方法权限，执行原本地提供器并提供节点状态。委托字符串或 SSH 登录本身不赋予权限。缺少适配时拒绝接收，不能绕回路由获取权限。

## 持久化与断链

`received/operations.json` 在执行前耐久记录待决，`sent/operations.json` 保留发送身份与结果。同号同参不重复执行，同号异参拒绝；丢回包标未知，通过认证只读回执恢复，不盲重发。存在未决发送时阻止新的写操作，容量满时拒绝而不淘汰。根目录 `owner.lock` 排斥双实例，遗留锁需人工确认后恢复。

断链拒绝新请求，已发送但无回包不能声称未执行。健康探测校验代次与节点自报身份；超 `staleMs` 标为过期，保留上次窗数，不伪造零窗。SSH 进程存活不等于应用握手成功。

## 模型体验

### 节点请求

#### 模型可见内容

`nodeLinkExecutor` 不新增工具或提示词；只传递既有方法请求和结果。接纳回执不代表模型已执行完成。

#### 词元影响

传输不额外调用模型，实际词元消耗由原本地操作决定。

#### KV 缓存影响

不改变会话历史或缓存前缀。

## 已知限制与待完成项

- 真实本地执行与授权审计适配由并线方提供；本包的替身测试不证明真实开窗、消息或授权账本已接通。Windows 实跑与真实 SSH 验收未执行。只支持一对配置节点，未提供多节点路由注册与热配置轮换。

- 业务执行适配须保证调用可收敛；卸载等待已接纳操作。持久存储为有限容量完整文件，未实现日志压缩、自动清理或遗留锁自动接管。凭据文件与发送接收记录不能作为引擎授权真源。
