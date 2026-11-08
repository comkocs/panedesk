# Platform behavior and sandbox session isolation

English | [中文](platform-behavior.zh.md)

## Platform behavior

Windows sandbox processes share the host console and can inject keys into CLI / TUI to impersonate approval or commands. Use an authenticated Web or desktop frontend for approval on Windows; console isolation is deferred. Interactive Windows CLI / TUI startup prints this warning.

Windows native sandbox enforcement has not been validated on a Windows machine. File tools use ordinary path writes. [Provider limitations](../../packages/sandbox/sandbox-local/README.md#known-limitations-and-deferred-work) distinguish parameter checks from native enforcement. Unrelated plugin projects and source clones remain writable. `danger-full-access` grants the host user's full write authority, including configuration and plugins.

Windows third-party platform cookies remain readable to low-integrity commands. See [desktop details](../../apps/desktop/README.md).

Scheduled tasks, WMI, COM, and ShellExecute delegation to an outside process remain unverified; run untrusted workloads under a separate OS account.

On Linux and macOS, a custom launcher that starts the CLI with an IPC channel must pass `--disable-sigusr1` on the Node command line; `NODE_OPTIONS` does not count, and a missing flag exits before profile and credential loading instead of restarting. Terminal, shell, systemd, pnpm-script, and SDK pipe launches are unchanged. The Windows desktop CLI launcher includes `--disable-sigusr1` and has test coverage, but has not been run on a Windows machine. See the [IPC launch upgrade guide](../upgrade-guide/v0.2.1-rc.2/ipc-cli-launch/guide.md).

In Web mode the login cookie is stored in the system browser's configuration directory. A process inside the sandbox can read it. See [sandbox session isolation and limitations](#sandbox-session-isolation-and-limitations).

| Platform | Sandbox | Write access | Bash default | Known limitations |
| --- | --- | --- | --- | --- |
| Windows | Restricted token with low integrity and directory capability ACLs; partial confinement. | Without an explicit mode, read-only with no workspace write grants. The first write in a workspace requests English/Chinese confirmation; allowing records consent and makes the workspace writable. Settings can preauthorize or revoke a workspace. Unattended sessions do not prompt: they stay read-only and explain how to enable writes. Explicit modes remain effective. | Disabled without an environment or settings selection; PowerShell is the alternative. | After permissions tighten, already-open processes and handles are not terminated; new tool calls immediately use the new policy. A persistent model terminal that rejects input after its permissions change must be closed and reopened. The permission-mode selector does not immediately reflect directory records. |
| Linux | bubblewrap (`bwrap`), with Landlock as fallback. | Defaults to workspace-write for workspace and temporary roots; explicit mode selection overrides it. | Enabled, using the configured Bash or `bash` on PATH. | Missing or unusable bubblewrap tries Landlock; no usable runner means refusal, never unconfined execution. Older Landlock ABIs may provide partial confinement. Native Node/workflow process tests require `PANEDESK_CI_NATIVE_SANDBOX=required`; otherwise they skip with a reason. Not every kernel configuration has been validated; the persistent pwsh terminal is unavailable under the native sandbox (no output reaches the reader; calls time out). |
| macOS | Seatbelt through `sandbox-exec`. | Defaults to workspace-write for workspace and temporary roots; explicit mode selection overrides it. | Enabled, using the configured Bash or `bash` on PATH. | Paths are normalized on the host. Seatbelt does not hide host processes; platform-injected regressions do not constitute native macOS validation. |

<a id="sandbox-session-isolation-and-limitations"></a>
## Sandbox session isolation and limitations

Start in a project directory rather than using `$HOME` as the workspace.

Bubblewrap gives both confined modes a private `/tmp` and masks host tmux, screen, session-bus, X11 and Wayland socket directories, including explicit runtime-directory overrides. Tools requiring these host sessions are unavailable inside that sandbox; ordinary temporary files use the private tmpfs. macOS Seatbelt denies outbound UNIX sockets under temporary and configured session directories; native macOS validation remains outstanding. See [runner details](../../packages/sandbox/sandbox-local/README.md#known-limitations-and-deferred-work).

Linux runners apply Landlock abstract-UNIX socket scope on kernels with ABI 6 or later. Without that scope, abstract sockets remain reachable: on an X11 desktop a sandbox process may inject keys into other windows. Startup is not refused for this limitation. Network isolation remains incomplete; run untrusted workloads under a separate account.

Landlock-only machines cannot hide pathname session sockets. If conventional user tmux, screen or session-bus locations exist, command startup warns in English and Chinese but does not refuse execution or change its exit code. Such sessions can execute commands outside confinement; run them under a separate user account. Network isolation remains incomplete; run untrusted workloads under a separate account.

Loopback networking is unrestricted. If local sshd accepts an available private key, `ssh localhost` can escape the sandbox. `~/.ssh` is not masked, preserving SSH-based Git pushes. Do not give untrusted workloads credentials for local services. These limits also mean session isolation is not a general sandbox-network guarantee; explicit full-access execution remains unchanged.

On Linux, host file operations performed for the model — reads, writes, edits, directory creation, staging and publication, metadata probes, and directory listing — open each canonical ancestor directory one component at a time without following links and address single entries through retained directory descriptors; a workspace directory replaced by a link cannot redirect these operations. On macOS and Windows, host file operations still resolve by path: a sandboxed process that replaces a workspace subdirectory with a link can direct host writes outside the authorized workspace, including in the default workspace-write mode. This restriction is maintained until a native directory-relative backend is verified on those platforms.

Login cookies use browser-session storage. A cookie remains valid across host restarts. See [authentication behavior](../../packages/client/connection/README.md#browser-authentication-and-request-trust) and [remaining limitations](../../packages/client/connection/README.md#known-limitations-and-deferred-work).
