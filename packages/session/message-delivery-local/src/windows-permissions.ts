/** Read-only Windows DACL admission; never rewrites inherited permissions. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MailboxUnavailableError, object } from './files.ts'

/** An access-control entry returned by the operating system. */
export interface AccessEntry {
  readonly sid: string
  readonly allow: boolean
  readonly rights: number
}

/** Refuse non-owner read/write grants, including inherited grants.
 * @param ownerSid - current authenticated user's SID.
 * @param entries - effective directory DACL entries.
 */
export function validateAcl(ownerSid: string, entries: readonly AccessEntry[]): void {
  if (!/^S-1-\d+(?:-\d+)+$/.test(ownerSid) || entries.length === 0) {
    throw new MailboxUnavailableError('Windows mailbox ACL is unavailable')
  }
  const trusted = new Set([ownerSid, 'S-1-5-18', 'S-1-5-32-544'])
  // Include data, attributes, extended attributes, delete and ACL/owner modification.
  const readWrite = 0x000f019f | 0x40000000 | 0x80000000 | 0x10000000
  for (const entry of entries) {
    if (entry.allow && !trusted.has(entry.sid) && (entry.rights & readWrite) !== 0) {
      throw new MailboxUnavailableError('Windows mailbox ACL grants another principal read or write access')
    }
  }
}

/** Inspect the inherited DACL once before any mailbox file is written.
 * @param home - product home whose inherited permissions protect the subtree.
 */
export async function inspectWindowsAcl(home: string): Promise<void> {
  const script = [
    '$ErrorActionPreference="Stop"',
    '$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$a=Get-Acl -LiteralPath $env:PANEDESK_MAILBOX_ACL_PATH',
    '$e=@($a.Access | ForEach-Object { @{ sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; allow=($_.AccessControlType -eq "Allow"); rights=[int]$_.FileSystemRights } })',
    '@{ owner=$u; entries=$e } | ConvertTo-Json -Compress -Depth 4',
  ].join('; ')
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PANEDESK_MAILBOX_ACL_PATH: home },
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  })
  const result: unknown = JSON.parse(stdout)
  if (!object(result) || typeof result.owner !== 'string' || !Array.isArray(result.entries)) {
    throw new MailboxUnavailableError('Windows mailbox ACL response is unavailable')
  }
  const entries: AccessEntry[] = result.entries.map((entry: unknown) => {
    if (!object(entry) || typeof entry.sid !== 'string' || typeof entry.allow !== 'boolean'
      || typeof entry.rights !== 'number' || !Number.isInteger(entry.rights)) {
      throw new MailboxUnavailableError('Windows mailbox ACL entry is unavailable')
    }
    return { sid: entry.sid, allow: entry.allow, rights: entry.rights }
  })
  validateAcl(result.owner, entries)
}
