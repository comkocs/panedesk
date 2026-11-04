/** Windows startup copy derived from the mounted policy and interactive launch surface. */

/**
 * Warn interactive console owners without affecting unattended profiles.
 * @param platform - Host execution platform.
 * @param profile - Selected application profile.
 * @param args - Inner application arguments.
 * @param interactive - Whether the host receives terminal input.
 * @returns One bilingual line for Windows CLI/TUI, otherwise undefined.
 */
export function windowsConsoleNotice(platform: string, profile: string, args: readonly string[], interactive: boolean): string | undefined {
  if (platform !== 'win32' || !interactive || !['cli', 'tui'].includes(profile)) return undefined
  if (args.some(arg => ['--json', '--quiet', '-q'].includes(arg) || arg.startsWith('--dump-config'))) return undefined
  return 'panedesk: Windows sandbox processes share the host console and can inject keys into CLI / TUI to impersonate owner approval or commands. Use the desktop app for owner approval; console isolation is deferred. / Windows 沙箱进程与宿主共用控制台，能向 CLI / TUI 注入按键，冒充所有者答审批或敲命令。所有者审批请用桌面端；控制台隔离为后续工作。\n'
}

interface StartupPermissionPolicy {
  readonly defaultMode: string
  readonly defaultSource: 'default' | 'explicit'
}

/**
 * Build an optional stderr notice without changing machine-readable output.
 * @param platform - Host execution platform.
 * @param args - Inner application arguments.
 * @param policy - Actual mounted deployment policy, absent for profiles without confinement.
 * @returns One bilingual line, or undefined when startup should stay silent.
 */
export function windowsPermissionNotice(
  platform: string,
  args: readonly string[],
  policy: StartupPermissionPolicy | undefined,
): string | undefined {
  if (platform !== 'win32' || policy === undefined) return undefined
  if (args.some(arg => ['--json', '--quiet', '-q'].includes(arg) || arg.startsWith('--dump-config'))) return undefined
  const source = policy.defaultSource === 'default' ? 'default / 缺省' : 'explicit / 显式'
  return `panedesk: Windows file permissions / Windows 文件权限: ${policy.defaultMode} (${source}). Change PANEDESK_PERMISSION_MODE or Settings > General > Windows workspace write access / 可设置环境变量或在设置 > 通用 > Windows 工作区写权限中修改。\n`
}
