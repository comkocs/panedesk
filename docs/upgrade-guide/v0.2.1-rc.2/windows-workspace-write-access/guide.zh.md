---
kind: upgrade-guide
description: 未显式选择权限模式的 Windows 部署现在以只读模式启动，不再默认允许工作区写入。
---

# Windows 工作区写权限

[English](guide.md) | 中文

## 变更

Windows 缺省为 `read-only`；Linux 和 macOS 保持 `workspace-write`。显式环境变量、sandbox-policy 和会话模式不变。基础配置没有可写回退值。

通用设置管理内置 Windows 沙盒的目录写入。同意仅在平台缺省模式下启用写入；已有 ACE 不算同意。首次写入获批后保存同意并物化 ACL。拒绝、取消、无应答者及到期均保持只读。无人值守 headless 使用 `never`，恢复会话也如此。初始化时已认证且可应答的 owner 流保留策略；稍后连接不会解除 `never`。Windows 原生执行仍未经验证。

Windows 隐式默认模式不允许激活动态 Cordis 包，包括浏览器面板启动和此前批准过的版本。同进程 Host 与同源 Client 代码可触达 owner 审批能力。目录写权限不会启用动态代码；检查和定义存储仍可用。

受沙盒约束的写入排除宿主 profile、配置、插件输入与热加载根，包括活动监听及经符号链接前缀访问的缺失输入。授权允许包含保护输入，但不授予其写权；整个工作区受保护时仍拒绝。[提供者限制](../../../../packages/sandbox/sandbox-local/README.zh.md#known-limitations-and-deferred-work)说明同级位置写入及 Windows 替换校验。无关的开发克隆仍可写。重叠的临时根写授权被省略；输出请使用工作区。权限收紧影响新调用，不终止既有进程或句柄；模型持久终端若随后拒绝输入，需关闭后重开。权限模式选择器不即时反映目录记录。`danger-full-access` 授予宿主用户的全部写权，包括配置与插件；`plugin_manager` 每次变更仍须 owner 批准。

## 迁移

1. 不设置模式即可使用 Windows 只读缺省值。若不再需要之前配置的 `PANEDESK_PERMISSION_MODE=workspace-write`，请删除该覆盖。已有显式会话模式也优先于目录授权。
2. 在通用设置中，通过 **Windows 工作区写权限** 授权目录。确认目录已列出，再使用没有显式模式覆盖的会话。自定义运行器不支持此操作。
3. 检查标为 **旧版授权（无记录）** 的条目。发现范围是本机会话历史与已注册座席目录中的工作区根，不会扫描所有磁盘。撤销前先停止活动的工作区进程。撤销会删除产品沙盒的持久写 ACE 和授权记录，但不会终止运行中的进程或使已打开句柄失效。不要用删除记录代替 ACL 撤销。
4. 撤销失败时，请在设置中重试。持久撤销标记会阻止按目录授权，直到清理成功。显式部署或会话模式仍独立生效；如需只读运行，必须另行移除这些模式覆盖。
5. 保持隐式默认值即可禁用动态 Cordis 激活。显式部署模式不等于允许模型安装插件：每次 `plugin_manager` 变更现在都询问经认证的 owner，即使在 `danger-full-access` 下也如此。清单读取保留原权限检查。从运行过动态代码的部署返回隐式默认值时，建议重启 Host 并重新加载已连接页面，以清理运行状态；这不是首次写确认的前提。

见[策略](../../../../packages/sandbox/sandbox-policy/README.zh.md)及[权限设置](../../../../packages/client/ui-permission-presets/README.zh.md)。
