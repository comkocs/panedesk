---
description: "确认 Windows Git Bash 选择的宿主网关。"
kind: "package-reference"
---

# @panedesk/dsh-host-bash-setup

<a id="summary"></a>
## 概述

首启 Git Bash 探测远端:按常见 Windows 安装位置探测,并把用户确认后的产品选择提交为 base 档 Bash 与 PowerShell 行共用的门控依据。

[English](README.md) | 中文

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

把网关挂进面向 Web 的档;「设置 → 通用」行经生成的 `bashSetup` 远端面调用。`status` 报告宿主平台、探测到的第一个 Git Bash 可执行文件、已提交的选择,以及 `PANEDESK_BASH_PATH` 覆盖。`enable` 把一份确认过的 `{ enabled: true, bashPath }` 文档提交到 harness 主目录下的 `windows-bash.json`;`disable` 移除它,恢复平台缺省。全部文件事实与写入都来自 `@panedesk/dsh-bash-local`,base 档门控读的 Loader 表达式也由它承载。

### 一次写入意味着什么

提交是设置行里操作者确认动作的落盘效果;远端本身不追问。组合在下一次挂载档时读取已提交的选择,所以写入在应用重启后生效,且环境变量覆盖优先于已提交的选择。

<a id="understand-the-implementation"></a>
## 理解实现

### 设计思路

网关不自持状态:每次调用都经 bash-local 模块重读配置文件与探测候选,设置行因此不可能看到与 Loader 表达式将来读到的不一致事实。探测是对候选表的同步存在性检查;确认可执行文件真能运行这件事留给确认后的写入。

### 源码地图

- `src/index.ts` —— `BashSetupGateway` 远端服务与其三个方法。
- `src/types.ts` —— 状态快照的线上类型。
- `tests/bash-setup.spec.ts` —— 平台报告、确认后提交的流程、拒绝无路径选择。

<a id="further-exploration"></a>
## 延伸阅读

- [`@panedesk/dsh-bash-local`](../../shell/bash-local/README.zh.md) —— 候选表、配置文档格式与 base 档门控。
- [`@panedesk/dsh-client-ui-settings-bash`](../../client/ui-settings-bash/README.zh.md) —— 驱动本远端的设置通用行。

<a id="model-experience"></a>
## 模型体验

<a id="user-interface"></a>
### 用户界面

<a id="what-the-model-sees"></a>
#### 模型可见内容

本包不改任何模型输入或输出。

<a id="token-effect"></a>
#### Token 影响

界面与配置操作不消耗模型 token。

<a id="kv-cache-effect"></a>
#### KV 缓存影响

不涉及模型调用,无 KV 缓存影响。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **探测只查存在性** —— 存在但跑不起来的候选仍会被给出;确认后的写入不会试运行该可执行文件。
- **写入重启后生效** —— 提交后的即时重组推迟到有档重载路径承接时;设置行已写明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

网关名 `bashSetup` 即远端面名;客户端以 `ctx.remote.bashSetup` 访问。测试把 `PANEDESK_HOME` 指到临时目录,因为网关与产品路径一样读进程环境。

</details>
