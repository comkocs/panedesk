---
description: "Prebuilt system.node for Windows x64 private-file security."
kind: "package-library"
---
# @panedesk/node-addon-system-win32-x64

English | [中文](README.zh.md)

This platform package supplies `bin/system.node`, a stable Node-API v8 addon used by `@panedesk/node-addon-system/windows-private-files`. It contains no Landlock executable, POSIX flock binding, JavaScript loader or installation build script. Native Windows compilation requires matching MSVC and Node development files; real ACL behavior and latency require Windows acceptance.
