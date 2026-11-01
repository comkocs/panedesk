// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { LedgerCall, LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import { summarizeStats } from '@panedesk/dsh-ledger-query/src/stats.ts'
import { RemoteError } from '@panedesk/dsh-typert-protocol'
import type {} from '../src/types.ts'
import { StatsPanel, StatsSettings, StatsTools } from '../src/client/panel.tsx'
import { en, zh } from '../src/client/locales.ts'
import { selection } from '../src/client/selection.ts'

const asOf = Date.parse('2026-10-31T01:00:00Z')
const call: LedgerCall = { kind: 'call', start: {
  callId: 'call-a' as LedgerCall['start']['callId'], runId: 'run-a' as LedgerCall['start']['runId'],
  logicalRequestId: 'request-a' as LedgerCall['start']['logicalRequestId'], sessionId: 'session-a' as LedgerCall['start']['sessionId'],
  rootSessionId: 'session-a' as LedgerCall['start']['rootSessionId'], nodeId: 'local' as LedgerCall['start']['nodeId'],
  seat: 'seat-a', window: 'window-a', taskId: 'job-a', accountLabel: 'unknown', identitySource: 'startup',
  attemptIndex: 0, attemptVisibility: 'physical', provider: 'fixture', modelFamily: 'fixture', requestedModel: 'model-a',
  purpose: 'conversation', startedAt: asOf - 1000, cache: { cacheMode: 'unknown', breakReasons: [], prefixFingerprint: 'fingerprint-a' },
  cacheWriteTiering: { kind: 'unknown' }, priceVersion: 'price-v1', priceKey: 'model-a', referencePrice: true,
} }
const source: LedgerSnapshot = { asOf, complete: true, watermarks: {}, rows: [call] }
afterEach(cleanup)
function fixture(locale: typeof en, status = 'live', rows = source.rows, code?: 'stats/unauthorized' | 'stats/disabled' | 'stats/unavailable') {
  const value = { view: summarizeStats({ ...source, rows }, { range: 'today', bucket: 'hour', groupBy: 'seat' }, asOf), refreshIntervalMs: 10000 }
  const t = (key: keyof typeof en, args?: Record<string, string | number>) => Object.entries(args ?? {})
    .reduce((text, [name, replacement]) => text.replaceAll(`{${name}}`, String(replacement)), locale[key])
  const useResource = vi.fn(() => ({ status, value: status === 'loading' || status === 'none' || code ? undefined : value,
    failure: code ? new RemoteError(code, 'Read refused', {}) : undefined }))
  const props = { t, useResource } as ComponentProps<typeof StatsPanel>
  return { props, t, value, useResource }
}
it.each([['English', en], ['Chinese', zh]])('renders all five tabs and unknown call evidence in %s', (_language, locale) => {
  const h = fixture(locale)
  render(<StatsPanel {...h.props} />)
  expect(screen.getByRole('heading', { name: locale.title })).toBeTruthy()
  expect(screen.getByText(locale.projectNote)).toBeTruthy()
  expect(screen.getByRole('heading', { name: locale.runningLanes })).toBeTruthy()
  for (const tab of ['history', 'models', 'throughput', 'ledger'] as const) {
    fireEvent.click(screen.getByRole('button', { name: locale[tab] }))
    expect(screen.getByRole('table', { name: locale[tab === 'history' ? 'groups' : tab] })).toBeTruthy()
  }
  expect(screen.getByText('fingerprint-a')).toBeTruthy()
  expect(screen.getAllByText(locale.unknown).length).toBeGreaterThan(5)
  expect(screen.getByRole('columnheader', { name: locale.priceVersion })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: locale.pause }))
  expect(screen.getByText(locale.paused)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: locale.refresh }))
  expect(h.useResource.mock.calls.length).toBeGreaterThan(1)
})
it.each([['English', en], ['Chinese', zh]])('keeps the settings entry secondary and session entry inside a menu in %s', (_language, locale) => {
  const h = fixture(locale), open = vi.fn(), close = vi.fn()
  const settings = { ...h.props, open, close } as ComponentProps<typeof StatsSettings>
  const rendered = render(<StatsSettings {...settings} />)
  expect(screen.getByText(locale.description)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: locale.open }))
  expect(close).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce()
  rendered.unmount()
  const sessionId = call.start.sessionId
  const row = { id: sessionId, displayTitle: 'Session', running: false, retainedBy: {}, blank: false, updatedAt: 0,
    projectionValues: { agentPreset: 'standard' } }
  const sessions: Parameters<Parameters<ComponentProps<typeof StatsTools>['useSessions']>[0]>[0] = { ids: [sessionId], byId: { [sessionId]: row }, phase: 'ready', projectionsBySession: {} }
  const useSessions: ComponentProps<typeof StatsTools>['useSessions'] = select => select(sessions)
  const tools = { sessionId, t: h.t, open, useSessions } as ComponentProps<typeof StatsTools>
  const toolbar = render(<StatsTools {...tools} />)
  expect(screen.queryByRole('menuitem')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: locale.tools }))
  fireEvent.click(screen.getByRole('menuitem', { name: locale.title }))
  expect(open).toHaveBeenCalledTimes(2)
  row.projectionValues.agentPreset = 'minimal'
  toolbar.rerender(<StatsTools {...tools} />)
  expect(screen.queryByRole('button', { name: locale.tools })).toBeNull()
  expect(screen.queryByRole('menuitem')).toBeNull()
})
it.each(['overview', 'history', 'models', 'throughput', 'ledger'] as const)('handles every read state on %s without pretending a write succeeded', (tab) => {
  const cases = [
    ['none', undefined, 'idle'], ['loading', undefined, 'loading'], ['live', undefined, 'success'],
    ['failed', 'stats/unauthorized', 'unauthorized'], ['failed', 'stats/disabled', 'disabled'],
    ['failed', 'stats/unavailable', 'error'], ['failed', undefined, 'failed'],
  ] as const
  for (const [status, code, message] of cases) {
    const h = fixture(en, status, source.rows, code)
    const rendered = render(<StatsPanel {...h.props} />)
    fireEvent.click(screen.getByRole('button', { name: en[tab] }))
    expect(screen.getByText(en[message])).toBeTruthy()
    rendered.unmount()
  }
  const partial = fixture(en)
  partial.value.view.complete = false
  const incomplete = render(<StatsPanel {...partial.props} />)
  fireEvent.click(screen.getByRole('button', { name: en[tab] }))
  expect(screen.getByText(en.partial)).toBeTruthy()
  incomplete.unmount()
  const empty = render(<StatsPanel {...fixture(en, 'live', []).props} />)
  fireEvent.click(screen.getByRole('button', { name: en[tab] }))
  expect(screen.getAllByText(tab === 'overview' ? en.emptyRunning : en.empty).length).toBeGreaterThan(0)
  empty.unmount()
})
it.each([['English', en], ['Chinese', zh]])('shows token and price numbers on the overview cards when the ledger has both in %s', (_language, locale) => {
  const priced: LedgerCall = { kind: 'call', start: call.start, finish: {
    callId: call.start.callId, endedAt: asOf - 500, observedAt: asOf - 500, responseModelReported: 'same',
    effectiveModel: 'model-a', usageState: 'complete',
    usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 0 },
    costUsd: '0.42', pricingState: 'priced', wallMs: 500, modelInFlightMs: 400, queueMs: 0, backoffMs: 0,
    waits: [], compactionCount: 0, compactionTimes: [], endReason: 'completed', recovered: false,
  } }
  const h = fixture(locale, 'live', [priced])
  render(<StatsPanel {...h.props} />)
  expect(screen.getByRole('heading', { name: locale.tokens }).parentElement?.textContent).toContain('160')
  expect(screen.getByRole('heading', { name: locale.costUsd }).parentElement?.textContent).toContain('0.42')
  expect(screen.getByRole('heading', { name: locale.tokens }).parentElement?.textContent).not.toContain(locale.unknown)
  expect(screen.getByText(locale.emptyRunning)).toBeTruthy()
})
it.each([['English', en], ['Chinese', zh]])('pages ledger details and resets the cursor on refresh and filtering in %s', (_language, locale) => {
  const h = fixture(locale)
  const rows = Array.from({ length: 101 }, (_, i) => ({ ...call, start: { ...call.start,
    callId: `call-${String(i).padStart(3, '0')}` as typeof call.start.callId } }))
  h.useResource.mockImplementation((...args: unknown[]) => {
    const address = String(args[0])
    return { status: 'live', value: { ...h.value, view: summarizeStats({ ...source, rows }, selection(new URL(address).searchParams), asOf) }, failure: undefined }
  })
  render(<StatsPanel {...h.props} />)
  fireEvent.click(screen.getByRole('button', { name: locale.ledger }))
  expect(screen.queryByText('call-100')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: locale.nextPage }))
  expect(screen.getByText('call-100')).toBeTruthy()
  expect(screen.queryByText('call-000')).toBeNull()
  expect(screen.getByRole('button', { name: locale.nextPage }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: locale.previousPage }))
  expect(screen.getByText('call-000')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: locale.nextPage }))
  fireEvent.click(screen.getByRole('button', { name: locale.refresh }))
  expect(screen.getByText('call-000')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: locale.nextPage }))
  fireEvent.click(screen.getByRole('button', { name: `${locale.range}: ${locale.today}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: locale.all }))
  expect(screen.getByText('call-000')).toBeTruthy()
})
it('keeps a shared model filter visible and clearable after switching tabs', () => {
  const h = fixture(en)
  render(<StatsPanel {...h.props} />)
  fireEvent.click(screen.getByRole('button', { name: en.models }))
  fireEvent.click(screen.getByRole('button', { name: `${en.model}: ${en.all}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'model-a' }))
  fireEvent.click(screen.getByRole('button', { name: en.overview }))
  expect(screen.getByText(`${en.model}: model-a`)).toBeTruthy()
  expect(h.useResource).toHaveBeenLastCalledWith(expect.stringContaining('model=model-a'))
  fireEvent.click(screen.getByRole('button', { name: en.clear }))
  expect(h.useResource).toHaveBeenLastCalledWith(expect.not.stringContaining('model='))
})
it('selects Beijing today, rolling ranges, task grouping and day buckets through shared menus', () => {
  const h = fixture(en)
  render(<StatsPanel {...h.props} />)
  fireEvent.click(screen.getByRole('button', { name: `${en.range}: ${en.today}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: en['72h'] }))
  fireEvent.click(screen.getByRole('button', { name: `${en.groupBy}: ${en.seat}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: en.taskId }))
  fireEvent.click(screen.getByRole('button', { name: `${en.bucket}: ${en.hour}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: en.day }))
  expect(h.useResource).toHaveBeenLastCalledWith(expect.stringContaining('range=72h&bucket=day&groupBy=taskId'))
})
