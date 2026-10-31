// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it, onTestFinished } from 'vitest'
import { RemoteMock, ok } from '@panedesk/dsh-remote-mock'
import { TestClient, remoteDefaultResponses, webApp } from '@panedesk/dsh-client-test-runtime/src/assembly/index.ts'
import { summarizeStats } from '@panedesk/dsh-ledger-query/src/stats.ts'
import { en, zh } from '../src/client/locales.ts'

it.each([['en', en], ['zh', zh]] as const)('opens all five statistics tabs in the shipped client composition in %s without an initial-screen entry', async (language, labels) => {
  const view = summarizeStats({ asOf: 1, complete: true, watermarks: {}, rows: [] }, { range: 'all', bucket: 'hour', groupBy: 'seat' }, 1)
  const locale = { ns: 'locale', schema: {}, value: { preference: language }, base: {}, user: {},
    autoGenerate: true, applies: 'live' as const, secrets: [], revision: 1 }
  const welcome = { ...locale, ns: 'ui-settings-general', value: { welcomeNoticeVersion: '2026-09-28.1' } }
  const mock = RemoteMock.create().load(remoteDefaultResponses)
    .unary('settings/describe', ok({ writable: true, hasDocument: false, namespaces: [locale, welcome] }))
    .unary('settings/mutate', ok(locale))
    .unary('stats/read', ok({ view, refreshIntervalMs: 10000 }))
  const client = await TestClient.start({ roster: webApp }, mock, { mount: true })
  onTestFinished(() => client.dispose())
  await act(async () => { client.ctx.locale.setLocale(language) })
  expect(screen.queryByRole('button', { name: labels.title })).toBeNull()
  expect(screen.queryByRole('button', { name: labels.tools })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: language === 'en' ? 'Account menu' : '账号菜单' }))
  fireEvent.click(screen.getByRole('menuitem', { name: language === 'en' ? 'Settings' : '设置' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: labels.title })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: labels.title }))
  await waitFor(() => { expect(screen.getByRole('button', { name: labels.open })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: labels.open }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  await waitFor(() => { expect(screen.getByRole('heading', { name: labels.title })).toBeTruthy() })
  for (const tab of ['overview', 'history', 'models', 'throughput', 'ledger'] as const) {
    fireEvent.click(screen.getByRole('button', { name: labels[tab] }))
    await waitFor(() => { expect(screen.getAllByText(labels.empty).length).toBeGreaterThan(0) })
  }
  mock.unary('session/list', ok({ items: [{ sessionId: 'statistics-fixture', updatedAt: 1,
    running: false, blank: false, agentAvailable: true, cwd: '/statistics-fixture' }] }))
  mock.unary('session/projections', ok({ kind: 'sequenced', asOfSeq: -1, values: {} }))
  mock.unary('commands/list', ok([]))
  mock.unary('subagents/list', ok({ entries: [], parentAvailable: true }))
  mock.unary('terminal/list', ok([]))
  mock.unary('skills/list', ok({ skills: [] }))
  mock.unary('schedule/catalog', ok([]))
  mock.unary('schedule/list', ok([]))
  mock.unary('session/canOpenWorkspacePath', ok(true))
  mock.stream('job/list', (_args, stream) => { stream.push({ type: 'rows', jobs: [] }) })
  mock.stream('session/follow', (_args, stream) => {
    stream.push({ type: 'snapshot', header: { version: 3, id: 'statistics-fixture', createdAt: 1,
      cwd: '/statistics-fixture', isSeeded: false }, cursor: -1, records: [], hasMore: false,
    projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } })
  })
  await act(async () => { await client.ctx.sessions.refresh() })
  const sessionId = client.ctx.sessions.list.getSnapshot().ids[0]
  if (sessionId === undefined) throw new Error('Statistics session fixture is missing')
  await act(async () => { client.ctx.uiWorkspace.openSession(sessionId) })
  fireEvent.click(await screen.findByRole('button', { name: labels.tools }))
  fireEvent.click(screen.getByRole('menuitem', { name: labels.title }))
  await waitFor(() => { expect(screen.getByRole('heading', { name: labels.title })).toBeTruthy() })
  expect(mock.log.calls('stats/read').length).toBeGreaterThan(0)
  expect(mock.log.unmatched()).toEqual([])
}, 60000)
