# Release notes

## 0.1.3

The Linux launcher accepts `--scope-only -- <argv>...` for commands already confined by a mount namespace. Both launcher modes isolate abstract UNIX sockets on Landlock ABI 6 or later. Older kernels omit this optional scope without refusing scope-only commands; filesystem confinement retains its existing availability and enforcement semantics. The JavaScript entry exports `scopeOnlyArgs()` to construct the new invocation. Rebuild and distribute matching entry and platform packages together; older launcher binaries do not accept the new flag. Pathname sockets and TCP networking remain outside this scope.
