---
kind: upgrade-guide
description: 未显式选择权限模式的 Windows 部署现在以只读模式启动，不再默认允许工作区写入。
---

# Windows 工作区写权限

[English](guide.md) | 中文

## 变更

Windows 缺省为 `read-only`；Linux 和 macOS 保持 `workspace-write`。显式环境变量、sandbox-policy 和会话模式不变。基础配置没有可写回退值。

通用设置管理内置 Windows 沙盒的目录写入。同意仅在平台缺省模式下启用写入；已有 ACE 不算同意。首次写入获批后保存同意并物化 ACL：工作区可写，受保护路径仍拒写。拒绝、取消、无应答者及到期均保持只读。无人值守 headless 使用 `never`，恢复会话也如此。初始化时已认证且可应答的 owner 流保留策略；稍后连接不会解除 `never`。Windows 原生执行仍未经验证。

Windows 隐式默认模式不允许激活动态 Cordis 包，包括浏览器面板启动和此前批准过的版本。同进程 Host 与同源 Client 代码可触达 owner 审批能力。目录写权限不会启用动态代码；检查和定义存储仍可用。

受沙盒约束的写入排除宿主 profile、配置、插件输入与热加载根，包括活动监听及经符号链接前缀访问的缺失输入。授权允许包含保护输入，但不授予其写权；整个工作区受保护时仍拒绝。[提供者限制](../../../../packages/sandbox/sandbox-local/README.zh.md#known-limitations-and-deferred-work)说明同级位置写入及 Windows 替换校验。无关的开发克隆仍可写。重叠的临时根写授权被省略；输出请使用工作区。权限收紧影响新调用，不终止既有进程或句柄；模型持久终端若随后拒绝输入，需关闭后重开。权限模式选择器不即时反映目录记录。`danger-full-access` 授予宿主用户的全部写权，包括配置与插件；`plugin_manager` 每次变更仍须 owner 批准。

宿主兜底输入须获 owner 批准的覆盖，命令才能启动。诊断单列兜底；原生后端限制保持。

owner 自装的 MCP/provider 不受沙盒与首次写确认约束；请审查其能力。配置仍受保护；管理变更须 owner 批准。

授权记录及其规范化目标必须位于可写工作区之外。

## 迁移

1. 不设置模式即可使用 Windows 只读。删除非预期的 `PANEDESK_PERMISSION_MODE=workspace-write` 覆盖。显式会话模式也优先于目录授权。
2. 在通用设置中，通过 **Windows 工作区写权限** 授权目录。确认目录已列出，再使用没有显式模式覆盖的会话。自定义运行器不支持此操作。
3. 检查从本机会话及已注册座席目录发现的 **旧版授权（无记录）** 条目，不扫描全盘。撤销前停止工作区进程：撤销删除持久沙盒 ACE 和记录，不终止进程或关闭句柄。删除记录不会撤销 ACL。
4. 撤销失败时，请在设置中重试。持久撤销标记会阻止按目录授权，直到清理成功。显式部署或会话模式仍独立生效；如需只读运行，必须另行移除这些模式覆盖。
5. 保持隐式默认值即可禁用动态 Cordis 激活。每次 `plugin_manager` 变更均须经认证的 owner 批准，包括显式部署模式和 `danger-full-access`；清单读取检查保持。从动态代码部署返回后，建议重启 Host 并重新加载页面，但这不是首次写确认的前提。

6. 运行 `panedesk --profile headless --sandbox-status zh --json` 检查覆盖。恢复缺失的 owner 批准覆盖；不得删除可信记录或绕过隔离。见[诊断](../../../../packages/bundle/headless/README.zh.md)。

见[策略](../../../../packages/sandbox/sandbox-policy/README.zh.md)及[权限设置](../../../../packages/client/ui-permission-presets/README.zh.md)。
