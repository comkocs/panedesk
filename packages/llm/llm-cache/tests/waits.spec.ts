/** Call-local joins preserve wait categories and terminal timeout classification. */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@panedesk/cordis'
import { LlmError } from '@panedesk/dsh-llm'
import type { LedgerEvent, LedgerEventId } from '@panedesk/dsh-session-ledger'
import { consume, harness } from './harness.ts'
import { callWaits } from '../src/waits.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

describe('physical call waits and deadlines', () => {
  it.each(['sleep', 'subagent'] as const)('joins $0 wait facts during the call and excludes adjacent runs', async (kind) => {
    const { ctx, adapter, ledger } = await harness()
    contexts.push(ctx)
    if (ledger === undefined) throw new Error('Expected ledger')
    adapter.stream = async function* () {
      const start = ledger.starts[0]
      if (start === undefined) throw new Error('Expected call start')
      const interval = { kind, startedAt: start.startedAt + 1, endedAt: start.startedAt + 4, durationMs: 3 }
      const base = { schemaVersion: 1 as const, nodeId: start.nodeId, sessionId: start.sessionId,
        runId: start.runId, observedAt: start.startedAt + 4 }
      const events: LedgerEvent[] = [
        { ...base, eventId: 'wait-a' as LedgerEventId, kind: 'wait/start', interval: { kind, startedAt: interval.startedAt } },
        { ...base, eventId: 'wait-b' as LedgerEventId, kind: 'wait/end', interval },
        { ...base, eventId: 'wait-c' as LedgerEventId, kind: 'wait/end', interval },
        { ...base, eventId: 'wait-d' as LedgerEventId, kind: 'wait/end', interval: { kind, startedAt: start.startedAt - 10, endedAt: start.startedAt - 1 } },
      ]
      ledger.restored = { asOf: Date.now(), complete: true, watermarks: {}, rows: events.map(event => ({ kind: 'event', event })) }
      expect(callWaits(ledger.restored, start, start.startedAt + 3)).toEqual([{ ...interval, endedAt: start.startedAt + 3, durationMs: 2 }])
      await new Promise(resolve => setTimeout(resolve, 10))
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await consume(ctx)
    expect(ledger.ends[0]?.waits).toHaveLength(1)
    expect(ledger.ends[0]?.waits[0]).toMatchObject({ kind, durationMs: 3 })
  })

  it.each([false, true])('classifies call timeout for thrown failure: %s', async (thrown) => {
    const { ctx, adapter, ledger } = await harness()
    contexts.push(ctx)
    if (thrown) adapter.stream = () => { throw new LlmError('Model deadline reached', 'TIMEOUT') }
    else adapter.chunks = [{ type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT', message: 'Model deadline reached' } } }]
    await consume(ctx)
    expect(ledger?.ends[0]).toMatchObject({ endReason: 'timeout', timeoutSource: 'model-call', usageState: 'missing' })
  })
})
