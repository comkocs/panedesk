import { Context } from '@panedesk/cordis'
import { expect, it } from 'vitest'
import * as Subscriptions from '../src/index.ts'

it('keeps missing optional delivery and filesystem services inert and disposes listeners', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(Subscriptions, { maxBytes: 1024 })
  expect(Subscriptions.name).toBe('instruction-subscriptions')
  await fiber.dispose()
  await ctx.fiber.dispose()
})

it('rejects an invalid scan bound at activation', () => {
  expect(() => { Subscriptions.apply(new Context(), { maxBytes: 0 }) }).toThrow('maxBytes')
})
