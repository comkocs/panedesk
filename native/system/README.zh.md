---
description: "为 Linux 进程隔离与 POSIX 会话写锁提供预编译系统原语。"
kind: "package-library"
---
# @panedesk/node-addon-system

[English](README.md) | 中文

## Summary

使用 Linux `landlock-run` 可执行文件限制子进程，或通过 `./flock` 入口获取 POSIX 写锁。平台包包含预编译二进制；消费方安装时不会构建原生代码。Landlock 策略与会话生命周期仍由调用方负责。

## Table of Contents

- [使用](#use)
- [支持范围](#support)
- [开发](#development)

## Use

`@panedesk/node-addon-system/landlock-run` 为 Landlock 导出 `launcherPath`、`probe`、`grantArgs` 和 `scopeOnlyArgs`。两种启动器模式在 ABI 6 及以上隔离抽象 UNIX 套接字；旧内核省略该可选 scope，不因此拒起。`scopeOnlyArgs` 用于已由挂载隔离的命令，不增加文件系统限制。其可执行文件名、参数和失败语义由 [CLI 约定](docs/cli-contract.md) 定义。缺失或无权访问的授权路径会被省略，不改为授权其上级；其他规则失败仍阻止执行。

[flock 行为约定](docs/flock-contract.md) 将描述符、进程和咨询式锁语义对应到独立原生测试。

`@panedesk/node-addon-system/flock` 导出 `tryLockExclusive(fd): Promise<void>`。在调用完成前保持描述符打开。获取操作使用非阻塞独占 flock；发生竞争时，返回的 Promise 会以 `EAGAIN` 或 `EWOULDBLOCK` 拒绝，关闭该打开文件描述的最后一个描述符即释放锁。参见[入口 README](packages/entry/README.zh.md)。

`@panedesk/node-addon-system/windows-private-files` 在 Windows 提供同步元数据检查、仅属主 ACL 设置及同卷 `MoveFileExW` 替换。绑定不传文件内容，不回退 PowerShell；调用方负责路径校验、新鲜检查、文件句柄身份比对及内容刷盘。

导入任一入口都不会加载 addon。Landlock 可执行文件缺失时探测为不可用；flock 绑定缺失时拒绝获取。两条路径都不会进行编译，也不会静默允许不受支持的行为。

`@panedesk/node-addon-system/socket-cgroup` 加载实例拥有的 Linux 查询能力。`probe()` 检查内核套接字归属能力，不检查委派；`query(tuple)` 根据客户端方向的 IPv4 或 IPv6 端点，返回调用方网络命名空间中 TCP 套接字的 cgroup 标识。每次同步 netlink 查询最多 100 毫秒、256 个数据报；套接字不存在、属性缺失或转储不完整均抛错。本产品登记与后代匹配由宿主负责。已在 Linux 7.0 实测，最低内核版本未核定。

## Support

Linux x64/arm64 包包含静态 Landlock 可执行文件，以及分别用于 glibc/musl 的 `system.node` 文件。macOS x64/arm64 包仅包含 `system.node`。Windows x64/arm64 包仅包含私有文件 Win32 `system.node`；POSIX flock 与 Windows 锁文件行为不变。Landlock 还需要支持强制执行的 Linux 内核。[支持矩阵](docs/support-matrix.md) 指定构建者与验证负责人。

在 Landlock ABI 6 及以上内核上，launcher 还会应用 `LANDLOCK_SCOPE_SIGNAL`：受限进程不能向其 Landlock 域之外的进程发送信号，宿主仍可取消自己的子进程。较旧 ABI 不隔离同用户信号；`full`/`partial` 只描述文件系统强制执行。抽象 Unix 套接字不受作用域限制。

## Development

在本目录运行 `pnpm build:ts` 构建入口、`pnpm build:native` 构建当前宿主声明的原生产物、`pnpm build:test-oracle` 构建独立的 flock 系统调用 fixture（测试前置数据）。随后用 `pnpm test` 验证入口、锁、打包及可用的内核行为。Linux 完整构建需要 musl-gcc；macOS 使用 cc。Windows 要求匹配架构的 MSVC 开发环境、`node.exe` 同级 `include/node` 下的 Node 开发头文件及同级匹配的 `node.lib`。Windows 编译与真实 ACL 验收必须在 Windows 执行，Linux 测试不能证明这些结果。根目录 `pnpm run build:native-system` 只构建源码测试所需的当前宿主 addon。

[架构](docs/architecture.md)、[打包](docs/packaging.md)和[发布流程](docs/release.md)分别负责实现与发布细节。

### Dev Note

无。
