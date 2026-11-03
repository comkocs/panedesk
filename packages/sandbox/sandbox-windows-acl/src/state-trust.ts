/** Owner records are authoritative only while the sandbox token cannot modify their storage ancestry. */
import { RestrictedFileAccess } from './access-token.ts'
import { inspectStateAncestors } from './state-access.ts'
import { workspaceWriteSid } from './workspace-sid.ts'
import type { StateAllowAce } from './ace-diagnostic.ts'

/** A state directory that a restricted workspace token can modify is not an authorization source. */
export class UnsafeWindowsStateError extends Error {
  /**
   * @param directory First writable storage ancestor.
   * @param mask Granted file access mask.
   * @param entries Matching explicit allow entries for owner remediation.
   */
  constructor(readonly directory: string, readonly mask: number, readonly entries: readonly StateAllowAce[] = []) {
    super(`Windows owner state is writable by the sandbox token at ${JSON.stringify(directory)} (access mask 0x${mask.toString(16)}). Inspect its ACL with icacls before retrying. / Windows 所有者状态目录的祖先可被沙箱令牌写入：${JSON.stringify(directory)}（权限掩码 0x${mask.toString(16)}），请先用 icacls 检查权限再重试。`)
    this.name = 'UnsafeWindowsStateError'
    for (const entry of entries) {
      this.message += `\nAllow ACE / 允许项: ${JSON.stringify(entry.directory)}; SID=${entry.sid}; mask=0x${entry.mask.toString(16)}; inherited / 继承=${entry.inherited}. Review then remove this trustee's explicit grants / 核对后移除该主体的显式允许项: ${entry.command}`
    }
  }
}

/**
 * Refuse writable state without reading or changing its records or ACLs.
 * @param directory State record directory or exact record filename.
 * @param workspace Canonical workspace whose persistent capability will be used.
 * @param temporarySids Temporary capabilities already selected for this execution.
 */
export function assertWindowsStateTrusted(directory: string, workspace: string, temporarySids: readonly string[] = []): void {
  if (process.platform !== 'win32') return
  const probe = RestrictedFileAccess.create([workspaceWriteSid(workspace), ...temporarySids])
  try {
    const unsafe = inspectStateAncestors(directory, probe)
    if (unsafe !== undefined) throw new UnsafeWindowsStateError(unsafe.path, unsafe.mask, probe.describe(unsafe.path, unsafe.mask))
  } finally { probe.dispose() }
}
