/** Live Agent input remains consumable across a delivery provider replacement. */
import { expect, it } from 'vitest'
import { SessionId } from '@panedesk/dsh-session'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import { composition } from './composition-fixture.ts'

it('consumes a reverse handoff on an existing Agent after delivery reload', async () => {
  const f = await composition()
  f.adapter.finish()
  try {
    const old = (await f.ctx.agents.create({ sessionId: SessionId('existing-window'),
      agentOptions: { provider: 'mock', model: 'model-a' } })).agent
    const first = await f.ctx.messageDelivery.send({ target: { sessionId: old.id }, content: 'Before reload',
      messageClass: 'handoff', operationId: 'before-reload' as OperationId })
    await expect.poll(() => f.adapter.requests.length).toBe(1)
    await old.whenIdle()
    expect(first.deliveryOutcome).toBe('accepted')
    await f.ctx.sessions.flush(old.session)
    const entry = [...f.ctx.loader.entries()].find(item => item.options.name === 'cordis:delivery')!
    await entry.fiber!.dispose()
    await f.ctx.loader.create({ name: 'cordis:delivery', config: { dshHome: f.home,
      maxRecordBytes: 1048576, maxContentBytes: 4096, maxBatchSize: 100,
      lockTimeoutMs: 5000, lockRetryMs: 1, scanIntervalMs: 100, watch: false } })
    await f.ctx.loader.await()
    const next = await f.ctx.messageDelivery.send({ target: { sessionId: old.id }, content: 'Reverse after reload',
      messageClass: 'handoff', priority: 'steer', operationId: 'after-reload' as OperationId })
    expect(next.deliveryOutcome).toBe('accepted')
    await expect.poll(() => f.adapter.requests.length).toBe(2)
    await old.whenIdle()
    expect(JSON.stringify(f.adapter.requests[1])).toContain('Reverse after reload')
    await expect.poll(async () => (await f.ctx.messageDelivery.list({ targetSessionId: old.id })).items
      .find(item => item.messageId === next.messageId)?.state).toBe('responded')
  } finally { await f.close() }
}, 20000)
