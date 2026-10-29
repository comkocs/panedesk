# Support matrix

| Platform package suffix | Builder | Payload |
|---|---|---|
| linux-x64 | ubuntu-24.04 | static Landlock executable; glibc and musl system.node |
| linux-arm64 | ubuntu-24.04-arm | static Landlock executable; glibc and musl system.node |
| darwin-x64 | macos-15-intel | system.node |
| darwin-arm64 | macos-latest | system.node |
| win32-x64 | windows-latest | private-file Win32 system.node |
| win32-arm64 | windows-11-arm | private-file Win32 system.node |

The stable Node-API v8 addon is built once per platform/libc and exercised by CI under Node 20, 22, 24, and 26. macOS builds target 11.0 or later. Linux binding selection uses the running Node process's libc; the static launcher serves both libc variants.

Landlock additionally requires an enforcing Linux kernel. The functional probe determines full, partial, or unusable enforcement; kernel version alone is not an availability guarantee.

Windows has neither a Landlock launcher nor the POSIX flock addon. Its separate private-file addon performs SID/DACL inspection, owner-only ACL creation and write-through replacement; Windows lock-file behavior is unchanged. MSVC builds require matching Node headers and node.lib. Windows compilation, installed-artifact checks and real ACL/latency acceptance are not established by Linux test doubles. Other CPU/OS combinations have no published platform package: Landlock probes unusable, and flock acquisition rejects. New platform support requires a native builder and installed-artifact verification.
