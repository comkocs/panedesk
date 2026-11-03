/** Owner-visible state refusal includes the exact remediation target in both locales. */
import { expect, it } from 'vitest'
import { UnsafeWindowsStateError } from '../src/state-trust.ts'

it('reports the state refusal and explicit-allow removal warning in English and Chinese', () => {
  const error = new UnsafeWindowsStateError('C:\\state-ancestor', 0x40000, [{
    directory: 'C:\\state-ancestor', sid: 'S-1-4-123-456', mask: 0x40000, inherited: false,
    command: "icacls.exe 'C:\\state-ancestor' /remove:g '*S-1-4-123-456'",
  }])
  expect(error.message).toContain('Windows owner state is not trusted: the sandbox token can modify "C:\\\\state-ancestor" (access mask 0x40000). First-write approval is refused.')
  expect(error.message).toContain('Back up and review the directory and trustee first; /remove:g removes all explicit allow entries for this trustee.')
  expect(error.message).toContain('Windows 所有者状态不可信：沙箱令牌可修改 "C:\\\\state-ancestor"（权限掩码 0x40000）。已拒绝首次写入审批。')
  expect(error.message).toContain('请先备份并核对目录与主体；/remove:g 会移除该主体的全部显式允许项。')
  expect(error.message).toContain("icacls.exe 'C:\\state-ancestor' /remove:g '*S-1-4-123-456'")
})
