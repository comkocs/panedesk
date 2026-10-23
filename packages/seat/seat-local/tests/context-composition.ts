/** Threshold reminders use persisted call usage and successful compaction epochs. */
import { expect } from 'vitest'
import type { SessionId } from '@panedesk/dsh-session'
import Compaction from '@panedesk/dsh-compaction-basic'
import TokenMeter from '@panedesk/dsh-token-meter'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { engineFixture } from './engine-fixture.ts'
import type { CreationAdapter } from './creation-provider.ts'
import { recordCost } from './ledger-call.ts'
import { readContextUsage } from '../src/context-runtime.ts'
import { LocalSeatService } from '../src/service.ts'

/** Check real delivery and reconstruct epochs exclusively from persisted evidence.
 * @param f - installed local service and real ledger.
 * @param sessionId - exact window owner.
 * @param adapter - deterministic external model transport.
 */
export async function checkContextEpoch(f: Awaited<ReturnType<typeof engineFixture>>, sessionId: SessionId,
  adapter: CreationAdapter): Promise<void> {
  const agent = f.ctx.agents.get(sessionId)
  const service = f.ctx.get('seats')
  if (!agent || !(service instanceof LocalSeatService)) throw new Error('Context owner is unavailable')
  f.ctx.loader.builtins.compaction = Compaction
  f.ctx.loader.builtins.meter = TokenMeter
  const path = join(f.options.directory, 'compaction.yml')
  await writeFile(path, JSON.stringify([{ name: 'cordis:meter' }, { name: 'cordis:compaction', config: { auto: false } }]))
  await f.ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await f.ctx.loader.await()
  const usage = { inputTokens: 50, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 10 }
  const release = f.ctx.on('agent/turn-admitting', () => ({ kind: 'defer', reason: 'Inspect context reminder receipts.' }))
  try {
    await recordCost(f.ctx, sessionId, 'context-first', '0', usage)
    expect(await readContextUsage(f.ctx, sessionId)).toMatchObject({ status: 'known', tokens: 80, contextEpoch: 0 })
    const before = adapter.requests.length
    await service.reevaluateReport(sessionId)
    await service.reevaluateReport(sessionId)
    const messages = () => agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
      && JSON.stringify(event.data).includes('Context threshold reached.'))
    await expect.poll(() => messages().length).toBe(1)
    const compact = await f.ctx.compaction.compactNow(agent, new AbortController().signal)
    expect(compact).not.toBeNull()
    await f.ctx.sessions.flush(agent.session)
    expect(await readContextUsage(f.ctx, sessionId)).toMatchObject({ status: 'unknown' })
    await service.reevaluateReport(sessionId)
    expect(messages()).toHaveLength(1)
    await recordCost(f.ctx, sessionId, 'context-second', '0', usage)
    expect(await readContextUsage(f.ctx, sessionId)).toMatchObject({ status: 'known', tokens: 80, contextEpoch: 1 })
    await service.reevaluateReport(sessionId)
    await service.reevaluateReport(sessionId)
    await expect.poll(() => messages().length).toBe(2)
    expect(adapter.requests).toHaveLength(before + 1)
    await f.ctx.sessions.flush(agent.session)
    const saved = await f.ctx.sessionQuery.readSession(sessionId)
    expect(saved?.events.filter(event => event.type === 'compaction/end')).toHaveLength(1)
  } finally { release() }
}
