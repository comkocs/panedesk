---
description: "预编译 Landlock 启动器与异步 POSIX flock 的 JavaScript 入口。"
kind: "package-library"
---
# @panedesk/node-addon-system

[English](README.md) | 中文

`./landlock-run` 入口导出 Landlock 启动器路径、强制执行探测、授权参数和协议常量。独立的 `./flock` 入口导出 `tryLockExclusive(fd): Promise<void>`；导入任一入口都不会加载 `system.node`。包不提供根导出。

锁操作异步尝试 `LOCK_EX | LOCK_NB`。在完成前保持调用方拥有的描述符打开；竞争以 `EAGAIN`/`EWOULDBLOCK` 拒绝，其他系统调用失败也会拒绝，错误携带 code、值为正数的 errno 和 `syscall: 'flock'`。原生调用准备阶段的错误也会拒绝同一个 promise。关闭指向该打开文件描述的最后一个描述符即释放锁。绑定不打开、复制、关闭或显式解锁描述符。

`acquireExclusiveLockFile(path, options?)` 返回调用方拥有的专用锁文件句柄。POSIX 打开文件并调用未变的 `tryLockExclusive`；既有消费方保留原 POSIX 描述符与重试循环。仅 win32 使用 libuv `UV_FS_O_EXLOCK`（`0x10000000`），不依赖原生 addon。不得传入可读数据文件：Windows 也会排斥普通读者。只打开锁文件，从不读写其内容，且不得删除或替换。关闭句柄或退出进程即释放所有权。Windows 对 `EBUSY`/`EPERM` 进行有界退避重试，随后以 `EAGAIN` 报告且只携带文件名。默认预算为 100 毫秒，初始延迟 10 毫秒，倍增至 40 毫秒；等待型调用方传入既有超时及重试配置。`platform` 与 `open` 选项支持注入式平台测试。

可选操作系统/CPU 平台包携带二进制。它们的 `~x.y.z` 依赖范围允许同一次版本内的后续补丁版本。Linux 包含 `bin/landlock-run` 和分别用于两种 libc 的 `bin/glibc/system.node` / `bin/musl/system.node`；macOS 包含 `bin/system.node`。flock 绑定缺失或无法加载时，锁获取请求会被拒绝，不在安装时编译。Landlock 仍是遵循既有失败关闭协议的独立可执行文件；不支持的内核或平台探测结果为不可用。

`./windows-private-files` 导出 `inspectWindowsPrivatePath(path, directory?)`、`secureWindowsPrivatePath(path)` 及 `replaceWindowsPrivatePath(source, target)`。导入不加载原生模块；调用时仅加载匹配的 Windows 平台 addon，其他平台或二进制缺失即拒绝。检查返回当前与属主 SID、受保护 DACL 规则及新鲜的祖先重解析点结果，可同时检查文件与根目录。secure 设置唯一当前用户 FullControl ACE 并禁用继承，只能由调用方用于新建空对象。替换返回 Win32 错误号，成功为零，保留 `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH` 且不跨卷复制；调用方先刷内容，负责有界重试、文件名及句柄身份检查。绑定不读取内容、不启动进程。

三个 C 源文件随包分发以供审计。参见工作区[架构](../../docs/architecture.md)、[支持矩阵](../../docs/support-matrix.md)和 [CLI 约定](../../docs/cli-contract.md)。
