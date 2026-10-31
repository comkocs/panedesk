// @vitest-environment jsdom
/** The shipped web roster owns session resources and reversible cache/session slot registrations. */
import { expect, vi } from 'vitest'
import { ok } from '@panedesk/dsh-remote-mock'
import { createClientTest, webApp } from '@panedesk/dsh-client-test-runtime/src/assembly/index.ts'
import { SESSION_FORMAT_VERSION, SessionSeq, type SessionId } from '@panedesk/dsh-session/types'
import { plainTurn } from '../../../api/session-controller/tests/event-script.client.ts'
import type {} from '../src/client/index.ts'
import type { ISessions } from '@panedesk/dsh-api-session-controller/client'
import type { SessionTabInjected } from '../src/client/SessionTabBody.tsx'
import type { PinActionInjected } from '../src/client/PinAction.tsx'

function pinInjection(value: Record<string, unknown> | undefined): PinActionInjected {
  if (value === undefined || typeof value.toggle !== 'function' || typeof value.hooks !== 'object' || value.hooks === null) {
    throw new Error('Missing pin injection')
  }
  return value as Record<string, unknown> & PinActionInjected
}

function bodyInjection(value: Record<string, unknown> | undefined): SessionTabInjected {
  if (value === undefined || typeof value.jump !== 'function' || typeof value.hooks !== 'object' || value.hooks === null) {
    throw new Error('Missing session tab injection')
  }
  return value as Record<string, unknown> & SessionTabInjected
}

const SELF = '@panedesk/dsh-client-ui-session-tab'
const CACHE = '@panedesk/dsh-client-ui-cache-pill'
const SESSION = 'sidebar-retained' as SessionId
const it = createClientTest({ roster: webApp })
const mounted = createClientTest({ roster: webApp }, { mount: true })

mounted('renders a retained session conversation with its own composer through the shipped roster', async ({ mock, start }) => {
  mock.unary('session/list', ok({ items: [{ sessionId: SESSION, updatedAt: 1, running: false, blank: true, depth: 0 }] }))
  mock.stream('session/follow', (_args, stream) => {
    stream.push({ type: 'snapshot', header: { version: SESSION_FORMAT_VERSION, id: SESSION, createdAt: 0, isSeeded: false },
      cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } })
  })
  mock.unary('cacheView/read', ok({ rows: [{ sessionId: SESSION, role: 'main', kind: 'unknown' }], tiers: [], adjustable: false, complete: true }))
  mock.unary('commands/list', ok([]))
  mock.unary('skills/list', ok({ skills: [] }))
  const c = await start()
  c.ctx.uiWorkspace.openSession(SESSION)
  await c.flush()
  await vi.waitFor(() => { expect(c.ctx.sidebarRight.mounted.getSnapshot()).toBe(SESSION) })
  c.ctx.sidebarRight.openTab('session', { params: { sessionId: SESSION } })
  await vi.waitFor(() => {
    const page = c.container?.querySelector('[data-session-tab]')
    expect(page?.querySelector('[role="textbox"], [contenteditable], textarea'), page?.outerHTML).toBeTruthy()
    expect(page?.textContent).toMatch(/Pinned entries|钉住的条目/)
  })
  expect(mock.log.calls('session/prompt')).toHaveLength(0)
}, 60_000)

mounted('loads paged history and locates an old pin through the shipped conversation', async ({ mock, start }) => {
  const older = plainTurn(SessionSeq(0), 0, 'Older question', 'Older pinned answer')
  const newer = plainTurn(SessionSeq(6), 1, 'Recent question', 'Recent answer')
  const answer = older.find(event => event.type === 'assistant/message')
  if (answer?.type !== 'assistant/message') throw new Error('Missing assistant fixture')
  const messageId = answer.data.message.id
  mock.unary('session/list', ok({ items: [{ sessionId: SESSION, updatedAt: 1, running: false, blank: false, depth: 0 }] }))
  mock.stream('session/follow', (_args, stream) => {
    stream.push({ type: 'snapshot', header: { version: SESSION_FORMAT_VERSION, id: SESSION, createdAt: 0, isSeeded: false },
      cursor: 11, records: newer.map(event => ({ type: 'event', event })), hasMore: true,
      projections: { asOfSeq: 11, values: {} }, assistantStream: { revision: 0 } })
  })
  mock.unary('session/page', ok({ records: older.map(event => ({ type: 'event', event })), hasMore: false }))
  mock.stream('job/list', (_args, stream) => { stream.push({ type: 'rows', jobs: [] }) })
  mock.unary('schedule/list', ok([]))
  mock.unary('schedule/catalog', ok([]))
  mock.unary('commands/list', ok([]))
  mock.unary('skills/list', ok({ skills: [] }))
  mock.unary('cacheView/read', ok({ rows: [], tiers: [], adjustable: false, complete: true }))
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  const scroll = vi.fn()
  const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scroll })
  try {
    const c = await start()
    c.ctx.uiWorkspace.openSession(SESSION)
    await vi.waitFor(() => { expect(c.ctx.sidebarRight.mounted.getSnapshot()).toBe(SESSION) })
    c.ctx.sidebarRight.openTab('session', { params: { sessionId: SESSION } })
    await vi.waitFor(() => { expect(c.container?.querySelector('[data-session-tab]')?.textContent).toContain('Recent answer') })
    const root = c.container!.querySelector<HTMLElement>('[data-session-tab]')!
    expect(root.textContent).not.toContain('Older pinned answer')
    const body = c.ctx.slots.entries('sidebar.right.pane.tab').find(entry => entry.locale === 'sessionTab')!
    await expect(bodyInjection(body.inject?.()).jump(root, messageId)).resolves.toBe(true)
    expect(mock.log.requests('session/page')).toMatchObject([{ beforeSeq: 6, maxMessages: 500 }])
    expect(root.textContent).toContain('Older pinned answer')
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
    expect(mock.log.calls('session/prompt')).toHaveLength(0)
  } finally {
    if (originalScroll === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll)
    vi.unstubAllGlobals()
  }
}, 60_000)

it('loads older history before locating a pin outside the rendered window', async ({ mock, start }) => {
  mock.unary('session/list', ok({ items: [{ sessionId: SESSION, updatedAt: 1, running: false, blank: false, depth: 0 }] }))
  mock.stream('session/follow', (_args, stream) => {
    stream.push({ type: 'snapshot', header: { version: SESSION_FORMAT_VERSION, id: SESSION, createdAt: 0, isSeeded: false },
      cursor: -1, records: [], hasMore: true, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } })
  })
  mock.unary('commands/list', ok([]))
  mock.unary('skills/list', ok({ skills: [] }))
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  const c = await start()
  const reference = c.ctx.sessions.retain(SESSION, { source: 'sessionTab' })
  const binding = await reference.ready
  const root = document.createElement('div')
  root.dataset.sessionTab = SESSION
  document.body.append(root)
  const target = document.createElement('div')
  target.dataset.messageId = 'older-message'
  const scroll = vi.fn()
  target.scrollIntoView = scroll
  const loadOlder = vi.spyOn(binding.session, 'loadOlder').mockImplementation(async () => { root.append(target) })
  try {
    const body = c.ctx.slots.entries('sidebar.right.pane.tab').find(entry => entry.locale === 'sessionTab')!
    await expect(bodyInjection(body.inject?.()).jump(root, 'older-message')).resolves.toBe(true)
    expect(loadOlder).toHaveBeenCalledTimes(1)
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
    expect(mock.log.calls('session/prompt')).toHaveLength(0)
  } finally { root.remove(); reference.release(); vi.unstubAllGlobals() }
}, 60_000)

it('loads both shipped contributions and releases cache polling and retained sessions on unload', async ({ mock, start }) => {
  mock.unary('session/list', ok({ items: [{ sessionId: SESSION, updatedAt: 1, running: false, blank: true, depth: 0 }] }))
  mock.stream('session/follow', (_args, stream) => {
    stream.push({ type: 'snapshot', header: { version: SESSION_FORMAT_VERSION, id: SESSION, createdAt: 0, isSeeded: false },
      cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } })
  })
  mock.unary('cacheView/read', ok({ rows: [{ sessionId: SESSION, role: 'main', kind: 'automatic', cacheReadTokens: 64 }], tiers: [], adjustable: false, complete: true }))
  mock.unary('commands/list', ok([]))
  mock.unary('skills/list', ok({ skills: [] }))
  const c = await start()
  const sessions: ISessions = c.ctx.sessions
  const assertEntries = (): void => {
    expect(c.ctx.slots.entries('conversation.composer.dock').filter(entry => entry.locale === 'cachePill')).toHaveLength(1)
    expect(c.ctx.slots.entries('sidebar.right.pane.tab').filter(entry => entry.locale === 'sessionTab')).toHaveLength(1)
    expect(c.ctx.slots.entries('conversation.chat.assistant-actions').filter(entry => entry.locale === 'sessionTab')).toHaveLength(1)
    expect(c.ctx.slots.entries('sidebar.session.conversation')).toHaveLength(1)
  }
  assertEntries()
  const evidence = c.ctx.resources.source(`dsh-resource://sessioncache/${SESSION}`)
  const transcript = c.ctx.resources.source(`dsh-resource://sessiontab/${SESSION}`)
  const stopCache = evidence.subscribe(() => {})
  const stopSession = transcript.subscribe(() => {})
  try {
    await vi.waitFor(() => { expect(evidence.getSnapshot()).toMatchObject({ status: 'live', value: { rows: [{ cacheReadTokens: 64 }] } }) })
    await vi.waitFor(() => { expect(transcript.getSnapshot().status).toBe('live') })
    expect(sessions.retainInfo(SESSION).getSnapshot().retainedBy.sessionTab).toBe(1)
    await c.reload(SELF)
    await c.flush()
    assertEntries()
    await vi.waitFor(() => { expect(sessions.retainInfo(SESSION).getSnapshot().retainedBy.sessionTab).toBe(1) })
    await c.unload(SELF)
    await c.flush()
    expect(c.ctx.slots.entries('sidebar.right.pane.tab').filter(entry => entry.locale === 'sessionTab')).toHaveLength(0)
    expect(c.ctx.slots.entries('sidebar.session.conversation')).toHaveLength(0)
    await vi.waitFor(() => { expect(sessions.retainInfo(SESSION).getSnapshot().retainedBy.sessionTab).toBeUndefined() })
    expect(transcript.getSnapshot().status).toBe('none')
    await c.unload(CACHE)
    expect(evidence.getSnapshot().status).toBe('none')
    expect(c.ctx.slots.entries('conversation.composer.dock').filter(entry => entry.locale === 'cachePill')).toHaveLength(0)
    expect(mock.log.calls('session/prompt')).toHaveLength(0)
  } finally { stopCache(); stopSession() }
}, 60_000)

it('publishes persisted pins to every occurrence only after the write succeeds and restores them on reload', async ({ mock, start }) => {
  localStorage.clear()
  const c = await start()
  const pinEntry = c.ctx.slots.entries('conversation.chat.assistant-actions').find(entry => entry.locale === 'sessionTab')!
  const injectPin = pinEntry.inject as ((id: SessionId) => Record<string, unknown>) | undefined
  const pin = pinInjection(injectPin?.(SESSION))
  expect(pin.toggle('message')).toBe('pinned')
  const body = c.ctx.slots.entries('sidebar.right.pane.tab').find(entry => entry.locale === 'sessionTab')!
  const injected = bodyInjection(body.inject?.())
  expect(injected.hooks.pins.getSnapshot()).toMatchObject({ status: 'ready', pins: [{ sessionId: SESSION, messageId: 'message' }] })
  await c.reload(SELF)
  const restored = c.ctx.slots.entries('sidebar.right.pane.tab').find(entry => entry.locale === 'sessionTab')!
  expect(bodyInjection(restored.inject?.()).hooks.pins.getSnapshot()).toMatchObject({ status: 'ready', pins: [{ messageId: 'message' }] })
  expect(mock.log.calls('session/prompt')).toHaveLength(0)
  localStorage.clear()
}, 60_000)
