/** Startup diagnostics never mix with machine-readable or quiet output. */
import { describe, expect, it } from 'vitest'
import { windowsConsoleNotice, windowsPermissionNotice } from '../src/windows-permission-notice.ts'

describe('Windows shared-console startup notice', () => {
  it.each(['cli', 'tui'])('warns once for Windows interactive %s', (profile) => {
    expect(windowsConsoleNotice('win32', profile, [], true)).toBe('panedesk: Windows sandbox processes share the host console and can inject keys into CLI / TUI to impersonate owner approval or commands. Use the desktop app for owner approval; console isolation is deferred. / Windows 沙箱进程与宿主共用控制台，能向 CLI / TUI 注入按键，冒充所有者答审批或敲命令。所有者审批请用桌面端；控制台隔离为后续工作。\n')
  })
  it('stays silent on Linux', () => {
    expect(windowsConsoleNotice('linux', 'tui', [], true)).toBeUndefined()
  })
  it.each(['headless', 'web', 'desktop', 'full', 'slim'])('stays silent for Windows %s', (profile) => {
    expect(windowsConsoleNotice('win32', profile, [], true)).toBeUndefined()
  })
  it('stays silent without an interactive terminal', () => {
    expect(windowsConsoleNotice('win32', 'cli', [], false)).toBeUndefined()
  })
})

describe('Windows permission startup notice', () => {
  const policy = { defaultMode: 'read-only', defaultSource: 'default' } as const
  it('reports the effective default and settings entry in both languages', () => {
    expect(windowsPermissionNotice('win32', [], policy)).toBe('panedesk: Windows file permissions / Windows 文件权限: read-only (default / 缺省). Change PANEDESK_PERMISSION_MODE or Settings > General > Windows workspace write access / 可设置环境变量或在设置 > 通用 > Windows 工作区写权限中修改。\n')
  })
  it.each(['linux', 'darwin'])('omits the notice on %s', (platform) => {
    expect(windowsPermissionNotice(platform, [], policy)).toBeUndefined()
  })
  it.each(['--json', '--quiet', '-q', '--dump-config', '--dump-config-schema', '--dump-config-schema-json'])('keeps %s output clean', (flag) => {
    expect(windowsPermissionNotice('win32', [flag], policy)).toBeUndefined()
  })
  it('reports explicit settings without consulting a different environment', () => {
    expect(windowsPermissionNotice('win32', [], { defaultMode: 'workspace-write', defaultSource: 'explicit' })).toContain('workspace-write (explicit / 显式)')
  })
  it('does not infer a policy for profiles without the service', () => {
    expect(windowsPermissionNotice('win32', [], undefined)).toBeUndefined()
  })
})
