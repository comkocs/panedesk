/** Startup diagnostics never mix with machine-readable or quiet output. */
import { describe, expect, it } from 'vitest'
import { windowsPermissionNotice } from '../src/windows-permission-notice.ts'

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
