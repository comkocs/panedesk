import { Context } from '@panedesk/cordis'
import { expect, it } from 'vitest'
import { composition } from './composition-fixture.ts'
import { config, sourceId, trigger } from './fixtures.ts'
import { SeatEngineReader } from '../src/reader.ts'

it('keeps accounting and message readers unchanged beside a queryable durable reminder', async () => {
  const h = await composition()
  const readerContext = new Context()
  try {
    const engine = h.ctx.seatEngine
    const before = await h.ctx.sessionLedger.snapshot()
    const messages = await h.ctx.sessionLedger.queryMessages({})
    const sessions = await h.ctx.sessionPersistence.list()
    const unregister = engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: async () => {} })
    try {
      expect((await engine.accept(trigger())).status).toBe('accepted')
      const live = await engine.query({ kinds: ['queue/reminded'], limit: 10 })
      expect(live.effects).toHaveLength(1)
      const reader = new SeatEngineReader(readerContext, { home: h.home,
        nodeId: await h.ctx.sessionLedger.nodeId(), maxDecisionBytes: config.maxDecisionBytes })
      expect(await reader.query({ kinds: ['queue/reminded'], limit: 10 })).toEqual(live)
      expect((await h.ctx.sessionLedger.snapshot()).rows).toEqual(before.rows)
      expect(await h.ctx.sessionLedger.queryMessages({})).toMatchObject({ items: messages.items, complete: messages.complete })
      expect(await h.ctx.sessionPersistence.list()).toEqual(sessions)
      expect(h.adapter.requests).toEqual([])
    } finally { await unregister() }
  } finally {
    await readerContext.fiber.dispose()
    await h.close()
  }
})
