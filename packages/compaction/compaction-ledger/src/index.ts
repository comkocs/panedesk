/** Optional ledger-backed checkpoint data and post-commit accounting; absent ledgers leave summaries unchanged. */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@panedesk/cordis'
import z from '@panedesk/schemastery'
import type { LedgerEventId, LedgerLifecycle } from '@panedesk/dsh-session-ledger'
import type {} from '@panedesk/dsh-compaction'
import { buildLedgerCheckpoint, LedgerCheckpointError, visibleLedgerSnapshot } from './checkpoint.ts'
import type { CompactionLedgerOptions } from './types.ts'
export type * from './types.ts'

/** Loader plugin identity. */
export const name = 'compaction-ledger'
/** Ledger availability is optional; all registrations unwind with the plugin. */
export const inject: string[] = []
/** Bounded checkpoint projection settings. */
export interface Config extends CompactionLedgerOptions {}
/** Runtime data budget and bounded snapshot retries. */
export const Config = z.object({
  recentEventLimit: z.number().step(1).min(0).default(10),
  maxTokens: z.number().step(1).min(1).default(1024),
  snapshotRetries: z.number().step(1).min(0).default(2),
})

/** Register bounded data contributions and accounting after successful replacement.
 * Snapshot errors stop admission; accounting errors propagate to the producer's post-commit reporter without rollback.
 * @param ctx - reversible plugin context; an absent ledger causes no reads or writes.
 * @param config - validated checkpoint limits.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('compaction/checkpoint', async (payload, next) => {
    const delegated = await next()
    const ledger = ctx.get('sessionLedger')
    if (ledger === undefined) return delegated
    payload.signal?.throwIfAborted()
    const filter = { sessionId: payload.session.id, includeChildren: true }
    const snapshot = visibleLedgerSnapshot(await ledger.snapshot(filter), payload.session.id)
    const checkpoint = buildLedgerCheckpoint(delegated, snapshot, payload.session.id, config,
      payload.additionalTokenBudget, payload.estimateTokens, payload.checkpoint.content)
    return {
      ...checkpoint,
      retryLimit: Math.min(config.snapshotRetries, delegated.retryLimit ?? config.snapshotRetries),
      validate: async () => {
        if (delegated.validate !== undefined && !await delegated.validate()) return false
        payload.signal?.throwIfAborted()
        const current = visibleLedgerSnapshot(await ledger.snapshot(filter), payload.session.id)
        return isDeepStrictEqual(snapshot.watermarks, current.watermarks)
          && isDeepStrictEqual(snapshot.rows, current.rows)
      },
    }
  })
  ctx.on('compaction/committed', async ({ session, result }) => {
    const ledger = ctx.get('sessionLedger')
    if (ledger === undefined) return
    const snapshot = visibleLedgerSnapshot(await ledger.snapshot({ sessionId: session.id, includeChildren: true }), session.id)
    const owner = snapshot.rows.filter((row): row is LedgerLifecycle => row.kind === 'run'
      && row.start.sessionId === session.id && row.finish === undefined)
      .sort((a, b) => b.start.startedAt - a.start.startedAt)[0]
    if (owner === undefined) throw new LedgerCheckpointError('identity')
    let peakContextUsageTokens: number | undefined
    for (const row of snapshot.rows) {
      if (row.kind !== 'call' || row.start.sessionId !== session.id || row.finish?.usage === undefined) continue
      const usage = row.finish.usage
      const input = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      peakContextUsageTokens = Math.max(peakContextUsageTokens ?? 0, input)
    }
    const committedAt = result.committedAt ?? Date.now()
    const outcome = await ledger.appendEvent({
      schemaVersion: 1,
      eventId: `compaction:${session.id}:${result.summarySeq}` as LedgerEventId,
      nodeId: owner.start.nodeId,
      runId: owner.start.runId,
      sessionId: session.id,
      observedAt: committedAt,
      kind: 'compaction',
      committedSeq: result.summarySeq,
      committedAt,
      ...peakContextUsageTokens === undefined ? {} : { peakContextUsageTokens },
      ...result.estimatedContextTokens === undefined ? {} : { peakContextEstimatedTokens: result.estimatedContextTokens },
    })
    if (outcome.kind === 'conflict') throw new LedgerCheckpointError('conflict')
  })
}
