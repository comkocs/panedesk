/** Linux process creation-identity checks; no probe ever sends a signal. */
import { readFile } from 'node:fs/promises'
import type { LedgerProcessIdentity } from '@panedesk/dsh-session-ledger'

/** Probe outcome keeps unverifiable identity distinct from confirmed death. */
export interface ProcessObservation {
  liveness: 'confirmed' | 'unknown' | 'dead'
  verification: 'verified' | 'unverified'
  reason: 'matching' | 'missing' | 'reused' | 'rebooted' | 'zombie' | 'unverified' | 'unreadable' | 'foreign-node'
}
/** Process-reader seam for deterministic platform and permission tests. */
export interface ProcessProbe {
  platform: string
  read(path: string): Promise<string>
}
/** Compare boot and start ticks, never PID alone; zombies count as dead.
 * @param identity - registered identity of the original process.
 * @param nodeId - explicitly configured local ledger node.
 * @param probe - optional platform reader; absence uses the local Linux proc filesystem.
 * @returns authoritative death/live evidence or unknown when verification is unavailable.
 */
export async function inspectProcessIdentity(identity: LedgerProcessIdentity, nodeId: string, probe: ProcessProbe = {
  platform: process.platform, read: path => readFile(path, 'utf8'),
}): Promise<ProcessObservation> {
  const unknown = (reason: ProcessObservation['reason']): ProcessObservation => ({ liveness: 'unknown', verification: 'unverified', reason })
  const dead = (reason: ProcessObservation['reason']): ProcessObservation => ({ liveness: 'dead', verification: 'verified', reason })
  if (identity.nodeId !== nodeId) return unknown('foreign-node')
  if (probe.platform !== 'linux' || identity.verification !== 'verified' || !identity.bootIdentity || !identity.startIdentity
    || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) return unknown('unverified')
  let boot: string
  try { boot = (await probe.read('/proc/sys/kernel/random/boot_id')).trim() }
  catch (error) { void error; return unknown('unreadable') }
  if (!boot) return unknown('unreadable')
  if (boot !== identity.bootIdentity) return dead('rebooted')
  let stat: string
  try { stat = await probe.read(`/proc/${identity.pid}/stat`) }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')) return dead('missing')
    return unknown('unreadable')
  }
  const closing = stat.lastIndexOf(')')
  if (closing < 0 || !stat.startsWith(`${identity.pid} (`)) return unknown('unreadable')
  const fields = stat.slice(closing + 1).trim().split(/\s+/)
  const state = fields[0], start = fields[19]
  if (!start || !/^\d+$/.test(start) || !state || !/^[RSDZTWtXxKPIN]$/.test(state)) return unknown('unreadable')
  if (start !== identity.startIdentity) return dead('reused')
  if (state === 'Z' || state === 'X' || state === 'x') return dead('zombie')
  return { liveness: 'confirmed', verification: 'verified', reason: 'matching' }
}
