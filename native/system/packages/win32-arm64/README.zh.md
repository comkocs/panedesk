---
description: "为 Windows ARM64 私有文件安全提供预编译 system.node。"
kind: "package-library"
---
# @panedesk/node-addon-system-win32-arm64

[English](README.md) | 中文

此平台包提供 `bin/system.node`，这是供 `@panedesk/node-addon-system/windows-private-files` 使用的稳定 Node-API v8 addon。不包含 Landlock 可执行文件、POSIX flock 绑定、JavaScript 加载器或安装构建脚本。原生 Windows 编译要求匹配的 MSVC 与 Node 开发文件，真实 ACL 行为和耗时须在 Windows 验收。
