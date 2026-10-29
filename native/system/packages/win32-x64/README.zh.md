---
description: "为 Windows x64 私有文件安全提供预编译 system.node。"
kind: "package-library"
---
# @panedesk/node-addon-system-win32-x64

[English](README.md) | 中文

此平台包提供 `bin/system.node`，这是供 `@panedesk/node-addon-system/windows-private-files` 使用的稳定 Node-API v8 addon。不包含 Landlock 可执行文件、POSIX flock 绑定、JavaScript 加载器或安装构建脚本。原生 Windows 编译要求匹配的 MSVC 与 Node 开发文件，真实 ACL 行为和耗时须在 Windows 验收。

Linux x64 构建机可使用 Zig 0.14.1 与 `node-api-headers` 1.9.0 交叉编译，不需要 Microsoft SDK 文件。在 `native/system` 中运行 `pnpm exec tsx scripts/build.ts --target win32-x64 --zig /absolute/path/to/zig --node-api-headers /absolute/path/to/package --output-dir /absolute/path/to/output --temporary-dir /absolute/path/to/temporary`。头文件包须包含 `include/node_api.h` 与 `def/node_api.def`；Zig 生成临时 Node 导入库，以 C11、优化、警告视为错误和 Node-API v8 编译。产物保留声明的 `bin/system.node` 路径，位于工作树之外，运行时仅依赖 Node 与 Windows 系统 DLL。打包前将其放入此平台包的 `bin/` 目录；二进制不提交，也没有安装时编译回退。Wine 加载与函数调用不能验证真实 Windows ACL 强制执行。
