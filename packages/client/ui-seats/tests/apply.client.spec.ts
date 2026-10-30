// @vitest-environment jsdom
/** Optional seat entries and resources use the production Client Loader and reversible registrations. */
import { expect, vi } from 'vitest'
import { FiberState } from '@panedesk/cordis'
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

it('keeps an explicitly disabled seat entry disabled across language changes', async ({ mock, start }) => {
  mock.unary('settings/mutate', ok(undefined))
  const c = await start()
  const entry = [...c.ctx.loader.entries()].find(row => row.options.name === SELF)
  if (!entry) throw new Error('Seat entry is missing')
  await entry.update({ disabled: true })
  await c.flush()
  for (const language of ['zh', 'en']) {
    c.ctx.locale.setLocale(language)
    await c.flush()
    expect(entry.options.disabled).toBe(true)
    expect(entry.disabled).toBe(true)
    expect(entry.fiber?.state).toBe(FiberState.DISPOSED)
    for (const [name] of entries) expect(c.ctx.slots.entries(name).filter(row => row.locale === 'seats')).toHaveLength(0)
  }
}, 60_000)

it('refreshes engine diagnostics without a Session event and clears them after recovery', async ({ mock, start }) => {
  const c = await start()
  const failure = { site: 'scheduled-drive', code: 'unclassified-error', since: '2026-01-01T00:00:00Z', retryable: false, attempts: 1 }
  let stopped = false
  mock.unary('seatUi/overview', () => ok({ available: true, definitions: [], windows: [], complete: true,
    ...(stopped ? { diagnostics: { engine: failure, openings: [] } } : {}) }))
  const source = c.ctx.resources.source('dsh-resource://seats/local')
  const stop = source.subscribe(() => {})
  try {
    await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('live') })
    stopped = true
    mock.streams.push('$events', { type: 'emit', event: 'seat/diagnostics-changed', args: [] })
    await vi.waitFor(() => { expect(source.getSnapshot().value).toMatchObject({ diagnostics: { engine: failure } }) })
    stopped = false
    mock.streams.push('$events', { type: 'emit', event: 'seat/diagnostics-changed', args: [] })
    await vi.waitFor(() => { expect(source.getSnapshot().value).not.toHaveProperty('diagnostics') })
    stop()
    const calls = mock.log.calls('seatUi/overview').length
    mock.streams.push('$events', { type: 'emit', event: 'seat/diagnostics-changed', args: [] })
    await c.flush()
    expect(mock.log.calls('seatUi/overview')).toHaveLength(calls)
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

it('uses configured models and existing import calls, selects only create and refreshes after commit', async ({ mock, start }) => {
  const c = await start()
  mock.unary('seatUi/overview', ok({ available: true, definitions: [], windows: [], complete: true }))
  mock.unary('session/modelCatalog', ok({ groups: [{ id: 'configured', name: 'Configured', models: [
    { id: 'model-a', name: 'Model A', reasoning: { defaultEffort: 'high' } },
    { id: 'model-b', name: 'Model B' },
  ] }] }))
  const request = { name: 'new-seat', directory: '/workspace', provider: 'configured', model: 'model-a', opening: 'Hello.' }
  const sourceRequest = { format: 'csv', sourcePath: '/host/home/seats/imports/source.csv', columnMap: { seat: 'seat' }, defaults: {} }
  mock.unary('seatUi/prepareAdd', ok(sourceRequest))
  mock.unary('seats/import.preview', ok({ planId: 'plan-a', baseRevision: 1, rows: [
    { row: 2, action: 'retain', diagnostics: [] }, { row: 3, action: 'create', diagnostics: [] },
  ] }))
  mock.unary('seats/import.commit', ok({ status: 'committed', revision: 2, rows: [] }))
  const entry = c.ctx.slots.entries('sidebar.seats').find(row => row.locale === 'seats')!
  const injected = entry.inject?.() as SeatsInjected & Record<string, unknown>
  expect(await injected.loadModels()).toEqual([
    { provider: 'configured', model: 'model-a', label: 'Configured / Model A', reasoningEffort: 'high' },
    { provider: 'configured', model: 'model-b', label: 'Configured / Model B' },
  ])
  const source = await injected.prepareAdd(request)
  expect(source).toEqual(sourceRequest)
  const plan = await injected.previewAdd(source)
  const resource = c.ctx.resources.source('dsh-resource://seats/local')
  const stop = resource.subscribe(() => {})
  try {
    await vi.waitFor(() => { expect(resource.getSnapshot().status).toBe('live') })
    const calls = mock.log.calls('seatUi/overview').length
    await injected.commitAdd(plan)
    expect(mock.log.calls('seats/import.commit')[0]).toMatchObject({ args: [{ request: {
      planId: 'plan-a', expectedRevision: 1, selectedRows: [3],
    } }] })
    await vi.waitFor(() => { expect(mock.log.calls('seatUi/overview').length).toBeGreaterThan(calls) })
    expect(mock.log.calls('session/prompt')).toHaveLength(0)
  } finally { stop() }
}, 60_000)

it('retains verified identity through an isolated read failure and recovers after reconnect', async ({ mock, start }) => {
  const sessionId = 'identity-session' as SessionId
  const binding = { kind: 'free', sessionId, nodeId: 'node-a', identitySource: 'free' }
  let failed = false
  const c = await start()
  mock.unary('seatUi/overview', () => ok({ available: true, definitions: [], windows: [], complete: true,
    ...(failed ? { identityStatus: 'failed' } : { binding }) }))
  const source = c.ctx.resources.source(`dsh-resource://seats/local?session=${sessionId}`)
  const stop = source.subscribe(() => {})
  try {
    await vi.waitFor(() => { expect(source.getSnapshot()).toMatchObject({ status: 'live', value: { binding } }) })
    failed = true
    c.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(source.getSnapshot()).toMatchObject({ status: 'live',
      value: { binding, identityStatus: 'failed' } }) })
    failed = false
    c.ctx.emit('connection/reset')
    await vi.waitFor(() => {
      const snapshot = source.getSnapshot()
      expect(snapshot).toMatchObject({ status: 'live', value: { binding } })
      expect(snapshot.value).not.toHaveProperty('identityStatus')
    })
  } finally { stop() }
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
  expect(injected.hooks.seatNotice.getSnapshot()?.message).toContain('Directory is not registered.')
  expect(injected.hooks.seatNotice.getSnapshot()?.message).toContain('Use profile directory')
  injected.dismiss()
  expect(injected.hooks.seatNotice.getSnapshot()).toBeNull()
}, 60_000)
