---
kind: upgrade-guide
description: 未显式选择权限模式的 Windows 部署默认以只读模式启动。
---

# Windows 工作区写权限

[English](guide.md) | 中文

## 变更

Windows 缺省为 `read-only`；Linux/macOS 保持 `workspace-write`。显式环境变量、sandbox-policy 和会话模式不变。基础配置没有可写回退值。

目录同意仅在平台缺省模式下生效；ACE 本身不算同意。审批保存同意并物化工作区 ACL，同时保留受保护输入。拒绝、取消、到期或没有应答者均保持只读。无人值守 headless 使用 `never`，恢复会话也如此；仅初始化时已认证且可应答的 owner 流保留审批策略，稍后连接不会解除限制。

Windows 隐式默认模式禁止激活动态 Cordis 包，包括此前批准的包及浏览器面板启动：其 Host/Client 代码可触达审批能力。目录同意不会启用这些包；检查和定义存储仍可用。

受限写入排除 profile、配置、插件与热加载输入，包括监听和经符号链接前缀访问的缺失路径。整个工作区受保护时仍拒绝；无关克隆仍可写。重叠临时授权被省略，请使用工作区输出。[提供方限制](../../../../packages/sandbox/sandbox-local/README.zh.md#known-limitations-and-deferred-work)说明同级写入与替换校验。宿主兜底输入须有 owner 批准的覆盖。owner 自装的 MCP/provider 不受此沙箱约束。

`danger-full-access` 保留宿主用户写权，包括配置和插件；每次 `plugin_manager` 变更仍要求经认证的 owner 审批及清单检查。模式选择器不即时反映目录记录。权限收紧影响新调用，不影响既有进程或句柄；持久终端拒绝输入时请重开。

状态存储及直至卷根的全部祖先，都必须拒绝沙箱令牌的写入、追加、DELETE 和父目录删除子项权限。不安全的记录不能授权写入或提供工作区配置。只读读取省略该配置；运行器启动前检查实际工作区与临时能力令牌。[原生限制](../../../../packages/sandbox/sandbox-windows-acl/README.zh.md#use-this-package)仍适用。Windows 原生执行仍未经实机验证。

## 迁移

1. 删除非预期的 `PANEDESK_PERMISSION_MODE=workspace-write` 及显式会话覆盖。在通用设置的 **Windows 工作区写权限** 中授权目录；不支持自定义运行器。
2. 检查从会话及已注册座席发现的 **旧版授权（无记录）**，不是全盘发现。撤销前停止工作区进程。跨重启撤销扫描全部精确工作区 SID 显式项，包括 `node_modules`；链接不引向树外。根和每个命中点均执行 AccessCheck，包括父目录删除子项权限。错误或残余写权保留撤销标记；请在设置中重试清理。显式模式仍独立生效。只删除记录不会撤销 ACL。
3. 保持隐式默认值以禁用动态激活。从动态代码部署返回后，建议重启 Host 并重新加载页面，但这不是首次写确认的前提。
4. 检查覆盖：`panedesk --profile headless --sandbox-status zh --json`。恢复审批覆盖；不得删除可信记录或绕过隔离。见[诊断](../../../../packages/bundle/headless/README.zh.md)。
5. 状态信任被拒时，备份并核对报告中的目录、SID 与 ACE。示例：`icacls.exe 'C:\state-ancestor' /remove:g '*S-1-4-123-456'`。替换为诊断中的精确值：此命令移除该主体全部显式允许项。继承授权须在来源处修正；诊断不完整时人工检查，绝不猜测删除。

已知旧根走撤销。状态祖先仅给手工处理说明。未知旧路径或 SID 按[精确 SID 步骤](../../../../README.zh.md)处理，绝不按前缀认领。
