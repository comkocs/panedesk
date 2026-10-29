---
description: "Prebuilt system.node for Windows x64 private-file security."
kind: "package-library"
---
# @panedesk/node-addon-system-win32-x64

English | [中文](README.zh.md)

This platform package supplies `bin/system.node`, a stable Node-API v8 addon used by `@panedesk/node-addon-system/windows-private-files`. It contains no Landlock executable, POSIX flock binding, JavaScript loader or installation build script. Native Windows compilation requires matching MSVC and Node development files; real ACL behavior and latency require Windows acceptance.

Linux x64 builders can cross-compile with Zig 0.14.1 and `node-api-headers` 1.9.0, without Microsoft SDK files. From `native/system`, run `pnpm exec tsx scripts/build.ts --target win32-x64 --zig /absolute/path/to/zig --node-api-headers /absolute/path/to/package --output-dir /absolute/path/to/output --temporary-dir /absolute/path/to/temporary`. The headers package must contain `include/node_api.h` and `def/node_api.def`; Zig generates a temporary Node import library and compiles C11 with optimization, warnings as errors and Node-API v8. The output retains the declared `bin/system.node` path, stays outside the checkout and requires only Node and Windows system DLLs. Supply it in this platform package's `bin/` directory before packing; binaries are not committed and no install-time compiler fallback exists. Wine loading and function calls do not validate real Windows ACL enforcement.
