---
kind: upgrade-guide
description: "Local sandbox commands no longer inherit access to conventional host session socket directories and require a matching native launcher."
---

# Sandbox session sockets

English | [中文](guide.zh.md)

## Change

Bubblewrap commands use private temporary and runtime directories in both restricted modes and clear host session-routing variables. Tools relying on host tmux, screen, D-Bus, X11, or Wayland sessions no longer work through these directories. Seatbelt profiles deny outbound UNIX connections beneath temporary and configured session directories. Linux launchers optionally isolate abstract UNIX sockets on Landlock ABI 6 or later; older kernels still start commands. Landlock-only commands retain pathname socket access and warn when conventional session locations exist.

## Migration

1. Upgrade the native entry and platform packages together to `@panedesk/node-addon-system` 0.1.3. Custom packaging must rebuild `landlock-run`; an older binary rejects `--scope-only`.
2. Keep workspaces outside `TMUX_TMPDIR` and `XDG_RUNTIME_DIR`: session masks hide overlapping workspace contents. Use ordinary files rather than host session sockets to exchange tool input and output. Do not select full access merely to restore session access.
3. Confirm that ordinary workspace commands and private temporary files still work, while a dedicated test session socket is inaccessible under bubblewrap. macOS native validation remains necessary for Seatbelt. Review the [remaining isolation limitations](../../../../README.md#sandbox-session-isolation-and-limitations); directory masks do not provide general network isolation.
