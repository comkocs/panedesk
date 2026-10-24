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

仅提供 `node.status`、`engine.pending`、`engine.approve`、`engine.operation`、`engine.query`。传输限定本机回环，拒绝浏览器来源、请求 cookie、非固定路径、错误 Host、旧进程代次及错误认证头。请求与响应均受完整帧字节上限约束。

<a id="configuration-and-identity"></a>
## 配置与身份

`runtime` 必须显式填写 `directory`、`nodeId`、`principalId`、`port`、`maxFrameBytes`、`requestTimeoutMs`、`maxPending`、`maxStoreBytes`、`maxOperations`。测试使用 `port: 0` 分配临时端口；部署端口由配置决定。配置经 Loader 装配，入口无命令行启动能力。

`directory` 为独占绝对路径，POSIX 目录权限必须为 `0700`，文件必须为当前属主的单硬链接普通文件且权限为 `0600`。祖先路径不得含符号链接；部署者还须保证祖先目录不可被非受信账号替换。Windows 必须提供 `hostAdminFiles`，负责等效 ACL、路径及原子耐久写入校验。

宿主创建 `credential` 与 `endpoint.json`，退出删除两者；每次启动生成独立进程代次。凭据仅通过私有文件和认证头传递，不进入参数、地址、环境变量或操作记录。`callAdmin` 只连接已运行宿主，缺少端点时拒绝，不自动启动服务。

`hostAdminExecutor` 接收传输导出的身份，必须在批准受理前完成授权事实的耐久记录，并继续应用原引擎闸门；请求字段不能赋予权限。缺少执行适配时，仅可调用已存在引擎的状态和待批准查询，其余方法明确拒绝。

<a id="persistence-and-recovery"></a>
## 持久化与恢复

`operations.json` 按主体与操作号保留摘要、待决状态或原始回执。先耐久写待决再执行，结果落盘后才公开；同号同参返回原结果，异参拒绝，丢回包保持未知，不自动重放。容量耗尽拒绝新操作，不淘汰未知记录。此接收记录不替代引擎授权账本。

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

- `createHostAdminExecutor` 组合宿主策略、受信授权签发器与授权事务。批准只调用事务适配，不再调用旧批准路径；查询效果载荷复用引擎校验器。并线方仍须提供真实授权服务，并验证任务过滤与默认脱正文查询。冻结引擎接口没有操作投影，操作查询保持不可用；替身不能证明生产接线。

- Windows ACL 实跑、真实 SSH 与多进程崩溃注入不在本包 Linux 替身测试覆盖内。执行提供器必须保证自身调用可终止；卸载会等待已接纳调用，不能强制取消任意提供器内部副作用。nonce 集合和操作记录有显式容量限制，满额后需受控重启或运维处理。

<a id="dev-note"></a>
### 开发备注

Keep administration behind the existing host and executor authority; do not start a second engine.
