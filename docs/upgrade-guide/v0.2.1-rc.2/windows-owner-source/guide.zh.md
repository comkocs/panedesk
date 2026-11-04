---
kind: upgrade-guide
description: "Windows owner 准入通过宿主持有的作业对象成员身份识别本产品沙箱进程。"
---

# Windows owner 连接来源

[English](guide.md) | 中文

## 变更

Windows 上来自已登记本产品沙箱的 TCP 连接，即使持有有效 cookie 也不能充当 owner。宿主查询 IPv4、IPv6 连接属主表，并检查属主进程是否属于产品作业对象。记录缺失、进程打不开、成员查询失败或传输缺少 TCP 事实时，判为 unknown，以中英原因拒绝 owner 准入。浏览器完整性、AppContainer 状态和受限令牌标志都不构成产品身份。产品作业对象外的 Edge、Chrome、Firefox 仍可认证。判定按物理连接缓存，涵盖 keep-alive 请求及升级。

## 迁移

同时升级本地沙箱、本地子进程与 Win32 进程包，然后重启宿主及既有沙箱进程。自定义消费者必须把 `productSandbox: true` 保留至普通和终端启动请求。提供者允许产品执行前先登记 Windows 查询器；可信 ACL runner 在创建任何受限子进程前加入宿主创建的 Job。普通命令不进入产品 Job。提供者卸载后拒绝新的 owner 连接，不回退为放行。cookie 持久化与新浏览器确认设置保持不变。

宿主跨提供者重载保留独立 Job 身份，退出时关闭；达到保留上限后拒绝新的沙箱启动，重启宿主可回收身份。每条命令原有 kill-on-close Job 仍独立归属。要求 Windows 8 / Server 2012 及以后版本，以及不带 UI 限制的合法嵌套 Job 层级；不兼容的外部 Job 限制会导致启动失败，不会无约束执行。参见[提供者生命周期](../../../../packages/subprocess/subprocess-local/README.zh.md)与微软的[嵌套 Job 限制](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)。

Windows 行为仅有替身测试，原生 Windows 验收尚未完成。查询持有进程句柄并复核属主，但进程号复用与连接替换竞态尚无原生验证。产品 Job 使用宿主令牌的缺省对象安全设置；同用户的其他进程可能保留额外句柄，因此不能仅凭宿主关闭断定已触发最后句柄关闭并终止成员。失败启动也占用保留身份上限。不登记宿主身份的独立 ACL 库调用或自定义提供者不在覆盖范围内。计划任务、WMI、COM、ShellExecute 可能委托 Job 层级外的进程创建目标；这些路径尚未核验，属于 M9 正式发布前必到的加固工作。可信宿主插件与 MCP 服务器仍在此保护范围之外。不改变 breakaway 标志、UI 限制、控制台设置或 ConPTY 参数。
