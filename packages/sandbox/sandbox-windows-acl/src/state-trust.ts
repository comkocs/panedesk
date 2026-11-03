/** Owner records are authoritative only while the sandbox token cannot modify their storage ancestry. */
import { RestrictedFileAccess } from './access-token.ts'
import { inspectStateAncestors } from './state-access.ts'
import { workspaceWriteSid } from './workspace-sid.ts'
import type { StateAllowAce } from './ace-diagnostic.ts'
import { en, zh } from './locales.ts'

/** A state directory that a restricted workspace token can modify is not an authorization source. */
export class UnsafeWindowsStateError extends Error {
  /**
   * @param directory First writable storage ancestor.
   * @param mask Granted file access mask.
   * @param entries Matching explicit allow entries for owner remediation.
   */
  constructor(readonly directory: string, readonly mask: number, readonly entries: readonly StateAllowAce[] = []) {
    super([en, zh].map(locale => locale.unsafeState(JSON.stringify(directory), `0x${mask.toString(16)}`)).join(' / '))
    this.name = 'UnsafeWindowsStateError'
    this.message += `\n${en.review} / ${zh.review}`
    for (const entry of entries) {
      this.message += `\n${[en, zh].map(locale => locale.allowEntry(
        JSON.stringify(entry.directory), entry.sid, `0x${entry.mask.toString(16)}`, entry.inherited,
      )).join(' / ')} ${entry.command}`
    }
    if (entries.length === 0) this.message += `\n${en.unknownTrustee} / ${zh.unknownTrustee}`
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
