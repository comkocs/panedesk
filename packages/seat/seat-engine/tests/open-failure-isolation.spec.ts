/** A rejected preset affects its reserved opening, not unrelated durable work. */
import { expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { auto, definition, harness, seat, trigger } from './fixtures.ts'
import { fact } from '../src/triggers.ts'
import { digest } from '../src/journal.ts'

it('isolates a missing preset before creation and recovers the remaining opening', async () => {
  const h = await harness({ ownerObserveIntervalMs: 60000, failureRecovery: { retryInitialMs: 1000 } })
  const healthy = 'healthy-seat' as T.SeatName
  h.definitions.set(healthy, definition(healthy))
  const create = h.executor.create.bind(h.executor)
  const frozenOpening = { text: 'Retained opening', digest: digest('Retained opening'),
    variables: { seat, date: '2026-01-01', taskId: null } }
  h.executor.create = async (open) => {
    if (open.definition?.seat === seat) {
      await h.engine.journal.commit(() => [fact({ kind: 'open/intent', data: { ...open, frozenOpening } })])
      throw Object.assign(new Error('Unknown agent preset'), {
        name: 'RemoteError', code: 'agent-preset/not-found', isDSHRemoteError: true,
        details: { agentPreset: open.definition?.agentPreset, available: [] },
      })
    }
    return create(open)
  }
  try {
    await auto(h.engine)
    await h.engine.accept(trigger())
    await h.engine.accept(trigger('external', 'healthy-event', healthy))
    await expect(h.engine.drive()).resolves.toBeUndefined()
    const opens = [...h.engine.journal.projection.opens.values()]
    expect(opens.find(open => open.definition?.seat === seat)?.frozenOpening).toEqual(frozenOpening)
    expect(opens.find(open => open.definition?.seat === seat)).toMatchObject({ phase: 'opening-failed',
      failure: { code: 'open-create-failed', retryable: false, effectState: 'none' } })
    expect(opens.find(open => open.definition?.seat === seat)?.failure).toMatchObject({
      details: { agentPreset: 'agent-a' },
    })
    expect(opens.find(open => open.definition?.seat === healthy)?.phase).toBe('active')
    expect(h.engine.journal.projection.resources.size).toBe(1)
    expect(h.creates).toHaveLength(1)
    expect((await h.engine.nodeStatus()).engine).toBe('running')
    await h.engine.shutdown()
    const restarted = await h.start()
    await restarted.drive()
    expect(h.creates).toHaveLength(1)
    expect(restarted.journal.projection.resources.size).toBe(1)
  } finally { await h.close() }
})
