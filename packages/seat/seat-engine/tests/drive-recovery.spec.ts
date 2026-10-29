/** Concurrent ingress waits for a drive that observes its durable admission. */
import { expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { auto, definition, harness, trigger } from './fixtures.ts'

it('drives an admission queued after the active drive captured its pending cut', async () => {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const second = 'second-seat' as T.SeatName
  let held = false
  h.definitions.set(second, definition(second))
  h.executor.configure = async () => {
    if (held) return
    held = true
    entered.resolve(undefined)
    await release.promise
  }
  try {
    await auto(h.engine)
    await h.engine.accept(trigger())
    const first = h.engine.drive()
    await entered.promise
    await h.engine.accept(trigger('external', 'second-event', second))
    const following = h.engine.drive()
    release.resolve(undefined)
    await Promise.all([first, following])
    expect(h.creates).toHaveLength(2)
    expect(h.engine.journal.projection.pending.size).toBe(0)
  } finally { release.resolve(undefined); await h.close() }
})
