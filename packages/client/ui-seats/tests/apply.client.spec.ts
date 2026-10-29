// @vitest-environment jsdom
/** Optional seat entries and resources use the production Client Loader and reversible registrations. */
import { expect, vi } from 'vitest'
import { ok, openStream } from '@panedesk/dsh-remote-mock'
import type { ISessions } from '@panedesk/dsh-api-session-controller/client'
import type { SessionId } from '@panedesk/dsh-session/types'
import { createClientTest, webApp } from '@panedesk/dsh-client-test-runtime/src/assembly/index.ts'
import { ClientRoster } from '@panedesk/dsh-client-test-runtime/src/assembly/roster.ts'
import type { SeatsInjected } from '../src/client/Seats.tsx'
import { SeatHeader, SeatPicker, SeatsSection } from '../src/client/Seats.tsx'

const SELF = '@panedesk/dsh-client-ui-seats'
const roster = ClientRoster.of([...webApp.rows, {
  name: SELF, immediately: false, inject: ['@panedesk/dsh-api-remotes', '@panedesk/dsh-client-resources',
    '@panedesk/dsh-client-ui-conversation', '@panedesk/dsh-client-ui-sidebar', '@panedesk/dsh-client-ui-workspace'],
}])
const it = createClientTest({ roster })
const entries = [['conversation.hero.seat', SeatPicker], ['sidebar.seats', SeatsSection],
  ['conversation.header.seat', SeatHeader]] as const

it('restores each slot contribution after declaration reload and removes slots, resources and listeners on unload', async ({ mock, start }) => {
  const c = await start()
  mock.unary('seatUi/overview', ok({ available: true, definitions: [], windows: [], complete: true }))
  const assertEntries = () => {
    for (const [name, component] of entries) {
      expect(c.ctx.slots.entries(name).filter(entry => entry.locale === 'seats').map(entry => entry.component)).toEqual([component])
    }
  }
  assertEntries()
  for (const owner of ['@panedesk/dsh-client-ui-conversation', '@panedesk/dsh-client-ui-sidebar']) {
    await c.reload(owner)
    await c.flush()
    assertEntries()
  }
  const source = c.ctx.resources.source('dsh-resource://seats/local')
  const stop = source.subscribe(() => {})
  try {
    await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('live') })
    const calls = mock.log.calls('seatUi/overview').length
    c.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(mock.log.calls('seatUi/overview').length).toBeGreaterThan(calls) })
    await c.reload(SELF)
    assertEntries()
    await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('live') })
    await c.unload(SELF)
    await c.flush()
    for (const [name] of entries) expect(c.ctx.slots.entries(name).filter(entry => entry.locale === 'seats')).toHaveLength(0)
    expect(source.getSnapshot().status).toBe('none')
    const afterUnload = mock.log.calls('seatUi/overview').length
    c.ctx.emit('connection/reset')
    await c.flush()
    expect(mock.log.calls('seatUi/overview')).toHaveLength(afterUnload)
    expect(() => { c.ctx.locale.register('seats', 'en', {})() }).not.toThrow()
    expect(() => { c.ctx.locale.register('seats', 'zh', {})() }).not.toThrow()
  } finally { stop() }
}, 60_000)

it('initializes the returned opening draft in the selected real Session binding without sending it', async ({ mock, start }) => {
  const sessionId = 'seat-prefilled' as SessionId
  const draft = 'Review the assigned files before making changes.'
  mock.unary('session/list', ok({ items: [{ sessionId, updatedAt: 1, running: false, blank: true, depth: 0 }] }))
  mock.stream('session/follow', openStream([]))
  const c = await start()
  mock.unary('seatUi/overview', ok({ available: true, definitions: [], windows: [], complete: true }))
  mock.unary('seatUi/open', ok({ status: 'prefilled', sessionId, draft, seat: 'seat-a', nodeId: 'node-a',
    nodeName: 'node-a', title: 'Seat window', budget: {}, phase: 'active', stateVersion: 1, callbackIds: [] }))
  const sessions = c.ctx.get('sessions') as ISessions
  await vi.waitFor(() => { expect(sessions.list.getSnapshot().byId[sessionId]).toBeDefined() })
  const entry = c.ctx.slots.entries('conversation.hero.seat').find(row => row.locale === 'seats')!
  const injected = entry.inject?.() as SeatsInjected & Record<string, unknown>
  await injected.openSeat({ seat: 'seat-a', revision: 1 } as Parameters<SeatsInjected['openSeat']>[0])
  const binding = sessions.binding(sessionId)
  expect(binding).toBeDefined()
  if (binding === undefined) throw new Error('The opening did not retain its Session')
  expect(c.ctx.conversation.input.for(binding.ctx).state.getSnapshot().draft).toBe(draft)
  expect(mock.log.calls('session/prompt')).toHaveLength(0)
  expect(injected.hooks.seatNotice.getSnapshot()).toBeNull()
}, 60_000)

it('aborts an in-flight overview when its last holder leaves', async ({ mock, start }) => {
  const pending = Promise.withResolvers<ReturnType<typeof ok>>()
  const c = await start()
  mock.unary('seatUi/overview', () => pending.promise)
  const calls = vi.spyOn(c.connection.rpc, 'call')
  const source = c.ctx.resources.source('dsh-resource://seats/local')
  const stop = source.subscribe(() => {})
  try {
    await vi.waitFor(() => { expect(calls.mock.calls.some(call => call[1] === 'seatUi/overview')).toBe(true) })
    const signal = calls.mock.calls.find(call => call[1] === 'seatUi/overview')?.[3]
    expect(signal?.aborted).toBe(false)
    stop()
    expect(signal?.aborted).toBe(true)
  } finally {
    stop()
    pending.resolve(ok({ available: false, definitions: [], windows: [], complete: true }))
    await c.flush()
  }
}, 60_000)

it('releases an unpinned resource and keeps opening refusals in the injected notice', async ({ mock, start }) => {
  const c = await start()
  mock.unary('seatUi/overview', ok({ available: true, definitions: [], windows: [], complete: true }))
  mock.unary('seatUi/open', ok({ status: 'rejected', error: { code: 'invalid-request',
    message: 'Directory is not registered.', alternative: 'Choose a registered directory.', retryable: false, effectState: 'none' } }))
  const source = c.ctx.resources.source('dsh-resource://seats/local')
  const stop = source.subscribe(() => {})
  await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('live') })
  stop()
  const calls = mock.log.calls('seatUi/overview').length
  c.ctx.emit('connection/reset')
  await c.flush()
  expect(mock.log.calls('seatUi/overview')).toHaveLength(calls)
  const entry = c.ctx.slots.entries('conversation.hero.seat').find(row => row.locale === 'seats')!
  const injected = entry.inject?.() as SeatsInjected & Record<string, unknown>
  await injected.openSeat({ seat: 'seat-a', revision: 1 } as Parameters<SeatsInjected['openSeat']>[0], '/registered')
  expect(mock.log.calls('seatUi/open')).toHaveLength(1)
  expect(mock.log.calls('seatUi/open')[0]).toMatchObject({ args: [{ request: { startupDirectory: '/registered' } }] })
  expect(injected.hooks.seatNotice.getSnapshot()?.message).toContain('invalid-request')
  injected.dismiss()
  expect(injected.hooks.seatNotice.getSnapshot()).toBeNull()
}, 60_000)
