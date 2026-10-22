/** Restore enforcement evidence from the ledger, never from Session log extensions. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'
import type { PresetExecutionPolicy } from '@panedesk/dsh-agent-preset-registry'
import { brandString } from '@panedesk/dsh-brand'
import type { SessionId } from '@panedesk/dsh-session'
import type { LedgerEventId, LedgerLifecycle } from '@panedesk/dsh-session-ledger'
import { SubagentError } from './error.ts'

/** Read the original child run and verify its complete execution policy before resuming.
 * @param ctx Runtime with optional ledger service.
 * @param parent Authorized direct parent.
 * @param childId Persisted child session to restore.
 * @param current Current definition; absence retains legacy behavior only without controlled evidence.
 * @returns Verified original policy and delivery declarations, or legacy defaults.
 */
export async function restoreExecutionEvidence(
  ctx: Context, parent: Agent, childId: SessionId, current?: PresetExecutionPolicy,
): Promise<{ executionPolicy?: PresetExecutionPolicy; deliveryPaths?: readonly string[] }> {
  const refuse = (reason: string): never => {
    throw new SubagentError(`Subagent cold restoration refused: ${reason}`, 'POLICY_RESTORE_DENIED')
  }
  const ledger = ctx.get('sessionLedger')
  if (ledger === undefined) {
    if (current !== undefined) refuse('original execution policy requires a ledger')
    return {}
  }
  const snapshot = await ledger.snapshot({ sessionId: childId })
  if (!snapshot.complete) refuse('original execution policy ledger snapshot is incomplete')
  const runs = snapshot.rows.filter((row): row is LedgerLifecycle => row.kind === 'run'
    && row.start.sessionId === childId && row.start.parentSessionId === parent.id)
  // Query projections are not ordered. Every controlled residency must retain the same original policy.
  const controlled = runs.filter(row => row.start.executionPolicy !== undefined || row.start.executionPolicyDigest !== undefined)
  if (controlled.length === 0) {
    if (current !== undefined) refuse('original execution policy run record is missing')
    const latest = runs.toSorted((a, b) => b.start.startedAt - a.start.startedAt)[0]
    return latest === undefined ? {} : { deliveryPaths: latest.start.deliveryPaths }
  }
  const original = controlled.toSorted((a, b) => a.start.startedAt - b.start.startedAt)[0]
  if (original === undefined) return refuse('original execution policy run record is missing')
  const run = original.start
  const { executionPolicyMetadata } = await import('@panedesk/dsh-agent-preset-registry')
  let metadata: ReturnType<typeof executionPolicyMetadata>
  try {
    if (run.executionPolicy === undefined) return refuse('original execution policy is missing')
    metadata = executionPolicyMetadata(run.executionPolicy)
    if (metadata.executionPolicyDigest !== run.executionPolicyDigest
      || controlled.some(row => row.start.executionPolicy === undefined
        || executionPolicyMetadata(row.start.executionPolicy).executionPolicyDigest !== row.start.executionPolicyDigest
        || row.start.executionPolicyDigest !== metadata.executionPolicyDigest)) {
      return refuse('original execution policy digest validation failed')
    }
  } catch (error) {
    if (error instanceof SubagentError) throw error
    return refuse('original execution policy is invalid')
  }
  const currentDigest = current === undefined ? undefined : executionPolicyMetadata(current).executionPolicyDigest
  if (currentDigest !== metadata.executionPolicyDigest) {
    const appended = await ledger.appendEvent({ schemaVersion: 1, eventId: brandString<LedgerEventId>(randomUUID()),
      nodeId: run.nodeId, observedAt: Date.now(), runId: run.runId, sessionId: childId, kind: 'alert',
      alert: { code: 'subagent-definition-changed', redacted: false,
        message: current === undefined ? 'Execution policy was removed; cold restoration denied'
          : 'Execution definition changed; cold restoration retains the original ledger policy' } })
    if (appended.kind === 'conflict') refuse('definition change alert could not be committed')
  }
  if (current === undefined) refuse('execution policy was removed from the current definition')
  return { executionPolicy: metadata.executionPolicy, deliveryPaths: run.deliveryPaths }
}
