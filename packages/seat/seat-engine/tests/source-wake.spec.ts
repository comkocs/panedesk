/** Source wake is opt-in, registry-bound and cannot fall back to an unconfigured opener. */
import { expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { auto, harness, sourceId, trigger } from './fixtures.ts'
import { validateConfig } from '../src/index.ts'

it('keeps default ingress unchanged and refuses configured wake without a source proxy', async () => {
  const f = await harness()
  try {
    const event = trigger()
    expect(await f.engine.wakeSource(event)).toBeUndefined()
    f.engine.options.config.sourceWake = [{ sourceId, eventTypes: ['event-a'] }]
    expect(await f.engine.wakeSource(event)).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
    expect(f.creates).toEqual([])
    expect(() => validateConfig({ ...f.engine.options.config, sourceWake: [{ sourceId, eventTypes: [] }] })).toThrow()
  } finally { await f.close() }
})

it('requires registered source context and explicit remote ownership before wake preparation', async () => {
  const f = await harness({ sourceWake: [{ sourceId, eventTypes: ['event-a'] }] })
  const stop = f.engine.registerSourceProxy({ target: async () => f.engine.options.nodeId,
    prepare: async () => { throw new Error('Local targets must not prepare remote work') },
    send: async () => { throw new Error('Local targets must not send remote work') } })
  try {
    await auto(f.engine)
    expect(await f.engine.wakeSource(trigger())).toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    const event: T.TriggerEnvelope = { ...trigger(), taskId: 'task-a' as T.SeatTaskId,
      openingContext: { providerId: 'source-provider' as T.OpeningProviderId,
        reference: 'task-a:1' as T.OpeningContextReference['reference'], revision: '1' } }
    expect(await f.engine.wakeSource(event)).toMatchObject({ status: 'rejected', error: { code: 'cross-node-unsupported' } })
    expect(await f.engine.wakeSource({ ...event, callbackRef: 'other-source' as T.SeatSourceId }))
      .toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    expect(f.creates).toEqual([])
  } finally { await stop(); await f.close() }
})
