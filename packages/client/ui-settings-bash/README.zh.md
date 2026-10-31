# @panedesk/dsh-client-ui-settings-bash

<!-- summary -->

设置通用行:经宿主探测 Windows 的 Git Bash 安装,确认后一键提交选择;找不到时给中英安装说明。

<!-- /summary -->

[English](README.md) | 中文

## 目录

- [使用本包](#using-this-package)
- [理解实现](#understanding-the-implementation)
- [延伸阅读](#further-reading)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

<a id="using-this-package"></a>
## 使用本包

把行挂进面向 Web 的档;它注册在设置面板通用区的 `settings.general.item` 槽上,全部事实都经生成的 `bashSetup` 远端面读取。非 Windows 宿主看到一行「只在 Windows 宿主上适用」的说明,没有动作。Windows 上,行报告首个探测命中及其完整路径,按钮点击就是把这个可执行文件提交为 base 档门控所读产品选择的确认动作。探测一无所获时,行改为承载中英安装说明。已提交的选择带一个恢复动作:删掉该文件,宿主回到 PowerShell 缺省。

### 一次点击提交什么

按钮点击就是完整的确认流程:前面没有对话框,点击之前不写任何东西。写入本身发生在宿主网关;本包只转发探测到的路径。

<a id="understanding-the-implementation"></a>
## 理解实现

### 设计思路

行持有一个异步视图,三个落定结果——探测命中、一无所获、已有提交选择——全部渲染分支都从这一视图加一对 busy/failure 派生。环境变量覆盖只报告、不管理:`PANEDESK_BASH_PATH` 已设时行说明这一点且不提供写入,因为门控求值时覆盖优先于已提交的选择。

### 源码地图

- `src/client/BashSetupRow.tsx` —— 行组件与其状态机。
- `src/client/locales.ts` —— 双语词典(zh 为键源)。
- `src/client/index.ts` —— 槽注册与远端面注入。

<a id="further-reading"></a>
## 延伸阅读

- [`@panedesk/dsh-host-bash-setup`](../../host/host-bash-setup/README.zh.md) —— 本行驱动的远端网关。
- [`@panedesk/dsh-bash-local`](../../shell/bash-local/README.zh.md) —— 候选表与已提交的产品文件。

<a id="model-experience"></a>
## 模型体验

#### 模型体验影响

本包不改任何模型输入或输出。

#### KV 缓存影响

不涉及模型调用,无 KV 缓存影响。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **重启后生效** —— 提交的写入只在档挂载时被读,所以变化在下一次应用启动生效;行内已就地写明。
- **暂无会话后提示** —— 设计还要求会话启动后给一次性提示;行已把整个流程收进设置内,提示条还没有干净槽位。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

组件测试直接喂行组件的注入面,用脚本化的 promise,中英各一遍,断言确认点击之前不发生写入。

</details>
