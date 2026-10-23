/** Owner death is acknowledged in the public run ledger before seat resources may be fenced. */
import { readFile } from 'node:fs/promises'
import type { Context } from '@panedesk/cordis'
import type { ResourceOwner, SeatNodeId } from '@panedesk/dsh-seat'
import type { LedgerProcessIdentity } from '@panedesk/dsh-session-ledger'
import type {} from '@panedesk/dsh-agent'

async function inspect(identity: LedgerProcessIdentity, nodeId: SeatNodeId): Promise<
  'alive' | 'unknown' | 'process-rebooted' | 'process-missing' | 'process-reused' | 'process-zombie'> {
  if (identity.nodeId !== nodeId || process.platform !== 'linux' || identity.verification !== 'verified'
    || !identity.bootIdentity || !identity.startIdentity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) return 'unknown'
  let boot: string
  try { boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() }
  catch (error) { void error; return 'unknown' }
  if (!boot) return 'unknown'
  if (boot !== identity.bootIdentity) return 'process-rebooted'
  let stat: string
  try { stat = await readFile(`/proc/${identity.pid}/stat`, 'utf8') }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error
      && (error.code === 'ENOENT' || error.code === 'ESRCH')) return 'process-missing'
    return 'unknown'
  }
  const closing = stat.lastIndexOf(')')
  if (closing < 0 || !stat.startsWith(`${identity.pid} (`)) return 'unknown'
  const fields = stat.slice(closing + 1).trim().split(/\s+/), state = fields[0], start = fields[19]
  if (!start || !/^\d+$/.test(start) || !state || !/^[RSDZTWtXxKPIN]$/.test(state)) return 'unknown'
  if (start !== identity.startIdentity) return 'process-reused'
  return ['Z', 'X', 'x'].includes(state) ? 'process-zombie' : 'alive'
}

/** Observe all residencies of the immutable Session identity, including after host restart.
 * @param ctx - executor scope resolving optional public runtime services.
 * @param owner - engine reservation identity; no PID is inferred from absence in the local registry.
 * @param nodeId - configured local node identity.
 * @returns dead only after complete run evidence and durable terminal acknowledgement; failures remain unknown.
 */
export async function observeOwner(ctx: Context, owner: ResourceOwner, nodeId: SeatNodeId): Promise<'alive' | 'dead' | 'unknown'> {
  if (ctx.get('agents')?.get(owner.sessionId)) return 'alive'
  const ledger = ctx.get('sessionLedger')
  if (!ledger) return 'unknown'
  try {
    const snapshot = await ledger.query({ sessionId: owner.sessionId })
    if (!snapshot.complete) return 'unknown'
    const runs = snapshot.rows.filter(row => row.kind === 'run' && row.start.sessionId === owner.sessionId)
    if (!runs.length) return 'unknown'
    for (const run of runs) {
      if (run.kind !== 'run' || run.start.nodeId !== nodeId) return 'unknown'
      if (run.finish) continue
      if (!run.start.processIdentity) return 'unknown'
      const observation = await inspect(run.start.processIdentity, nodeId)
      if (observation === 'alive' || observation === 'unknown') return observation
      const terminal = await ledger.finishRun({ runId: run.start.runId, observedAt: Date.now(), endReason: 'killed',
        upstreamStopReason: observation, recovered: true,
        deliveryState: run.start.deliveryPaths.length ? 'uncheckable' : 'not-requested' })
      if (terminal.kind === 'conflict' || terminal.event.kind !== 'run/end') return 'unknown'
    }
    // A newly started residency or a partial read must not inherit an older run's death.
    const current = await ledger.query({ sessionId: owner.sessionId })
    if (ctx.get('agents')?.get(owner.sessionId)) return 'alive'
    const residencies = current.rows.filter(row => row.kind === 'run' && row.start.sessionId === owner.sessionId)
    return current.complete && residencies.length > 0
      && residencies.every(row => row.kind === 'run' && row.start.nodeId === nodeId && row.finish !== undefined) ? 'dead' : 'unknown'
  } catch (error) {
    // Ledger or process evidence is unavailable; retain the reservation for the next observation.
    void error
    return 'unknown'
  }
}
