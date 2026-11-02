/** Windows startup copy derived from the mounted policy, never a second mode resolver. */
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
