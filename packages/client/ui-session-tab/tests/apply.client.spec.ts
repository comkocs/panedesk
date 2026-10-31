// @vitest-environment jsdom
/** The shipped web roster owns session resources and reversible cache/session slot registrations. */
import { expect, vi } from 'vitest'
import { ok } from '@panedesk/dsh-remote-mock'
import { createClientTest, webApp } from '@panedesk/dsh-client-test-runtime/src/assembly/index.ts'
import { SESSION_FORMAT_VERSION, type SessionId } from '@panedesk/dsh-session/types'
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
