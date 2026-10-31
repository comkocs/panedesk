// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { NodeHealthView } from '@panedesk/dsh-host-admin/types'
import type { SeatNodeId, CallbackId } from '@panedesk/dsh-seat/types'
import { RemoteError } from '@panedesk/dsh-typert-protocol'
import { NodesSection } from '../src/client/section.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const view: NodeHealthView = { nodes: [{ nodeId: 'node-b' as SeatNodeId, nodeName: 'Peer B', local: false,
  engine: 'unavailable', linkState: 'exhausted', safeReason: 'node-tunnel-exhausted', openWindows: null, limit: null,
  lastHeartbeatAt: null, rebuildable: true, events: [{ sequence: 1, at: '2026-01-01T00:00:00Z', kind: 'exhausted', safeReason: 'node-tunnel-exhausted' }] }],
callbacks: [{ callbackId: 'callback-a' as CallbackId, source: 'source-a', target: 'node-a', attempt: 7,
  phase: 'paused', parkingCode: 'transport-transient', detail: 'callback-transient-limit-reached',
  firstAttemptAt: '2026-01-01T00:00:00Z', lastAttemptAt: '2026-01-01T01:00:00Z', count: 7,
  attemptsAtLeast: true, latestReason: 'Original safe reason' }], callbacksAvailable: true, callbacksComplete: true,
sourceAvailable: true, sourceOperations: [{ key: 'source-original-key', state: 'awaiting-manual', eventId: 'event-a',
  target: 'node-b', since: '2026-01-01T00:00:00Z' }] }
function fixture(locale: typeof en, status = 'live', code?: 'nodes/unauthorized' | 'nodes/disabled' | 'nodes/unavailable', data = view) {
  const t = (key: keyof typeof en, args?: Record<string, string | number>) => Object.entries(args ?? {})
    .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), locale[key])
  const useResource = vi.fn(() => ({ status, value: status === 'none' || status === 'loading' || code ? undefined
    : { view: data, refreshIntervalMs: 1000 }, failure: code ? new RemoteError(code, 'Read refused', {}) : undefined }))
  const act = vi.fn(async () => ({ status: 'ok' as const }))
  return { props: { t, useResource, act } as ComponentProps<typeof NodesSection>, act }
}
it.each([['en', en], ['zh', zh]] as const)('renders evidence and confirms local-to-peer rebuild in %s', async (_language, labels) => {
  const h = fixture(labels)
  render(<NodesSection {...h.props} />)
  expect(screen.getByRole('heading', { name: labels.title })).toBeTruthy()
  expect(screen.getByText(labels.sinceStart)).toBeTruthy()
  expect(screen.getByText(labels.remoteOnly)).toBeTruthy()
  expect(screen.getByText(labels.atLeast.replace('{count}', '7'))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: labels.rebuild }))
  expect(h.act).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: labels.confirm })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: labels.confirm }))
  await waitFor(() => { expect(h.act).toHaveBeenCalledExactlyOnceWith({ kind: 'rebuild', peerNodeId: 'node-b' }) })
  await waitFor(() => { expect(screen.getByText(labels.actionSuccess)).toBeTruthy() })
})
it.each([['en', en], ['zh', zh]] as const)('keeps callback revision and source keys in confirmed resume and abandon in %s', async (_language, labels) => {
  const h = fixture(labels)
  render(<NodesSection {...h.props} />)
  fireEvent.click(screen.getAllByRole('button', { name: labels.resume })[0]!)
  fireEvent.click(screen.getByRole('button', { name: labels.cancel }))
  expect(h.act).not.toHaveBeenCalled()
  fireEvent.click(screen.getAllByRole('button', { name: labels.abandon })[0]!)
  fireEvent.click(screen.getByRole('button', { name: labels.confirm }))
  await waitFor(() => { expect(h.act).toHaveBeenCalledWith({ kind: 'callback', request: {
    callbackId: 'callback-a', expectedAttempt: 7, action: 'abandon' } }) })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  fireEvent.click(screen.getAllByRole('button', { name: labels.resume })[1]!)
  fireEvent.click(screen.getByRole('button', { name: labels.confirm }))
  await waitFor(() => { expect(h.act).toHaveBeenCalledWith(expect.objectContaining({ kind: 'source', action: 'resume',
    key: 'source-original-key', reason: labels.operatorReason })) })
})
it.each([['none', undefined, 'idle'], ['loading', undefined, 'loading'], ['failed', 'nodes/unavailable', 'error'],
  ['failed', 'nodes/unauthorized', 'unauthorized'], ['failed', 'nodes/disabled', 'disabled']] as const)
('reports %s %s without presenting missing observations as success', (status, code, key) => {
  render(<NodesSection {...fixture(en, status, code).props} />)
  expect(screen.getByText(en[key])).toBeTruthy()
})
it('reports empty, unavailable and incomplete observations explicitly', () => {
  const empty = { ...view, nodes: [], callbacks: [], sourceOperations: [], callbacksAvailable: false, sourceAvailable: false }
  render(<NodesSection {...fixture(en, 'live', undefined, empty).props} />)
  expect(screen.getByText(en.empty)).toBeTruthy()
  expect(screen.getByText(en.callbacksUnavailable)).toBeTruthy()
  expect(screen.getByText(en.sourceUnavailable)).toBeTruthy()
})
it('keeps a pending confirmation single-shot and displays a provider refusal', async () => {
  const h = fixture(en), result = Promise.withResolvers<{ status: 'rejected'; code: string }>()
  const act = vi.fn(() => result.promise)
  render(<NodesSection {...h.props} act={act} />)
  fireEvent.click(screen.getByRole('button', { name: en.rebuild }))
  expect(screen.getByRole('dialog').textContent).toContain(`${en.rebuild} · Peer B`)
  const button = screen.getByRole('button', { name: en.confirm })
  fireEvent.click(button); fireEvent.click(button)
  expect(act).toHaveBeenCalledTimes(1)
  expect(button.hasAttribute('disabled')).toBe(true)
  result.resolve({ status: 'rejected', code: 'admin-unauthorized' })
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(en.failed) })
  expect(screen.getByRole('alert').textContent).toContain('admin-unauthorized')
  expect(screen.queryByText(en.actionSuccess)).toBeNull()
})
it('labels partial observations and never offers rebuild for an unowned tunnel', () => {
  render(<NodesSection {...fixture(en, 'live', undefined, { ...view, callbacksComplete: false,
    nodes: view.nodes.map(node => ({ ...node, rebuildable: false })) }).props} />)
  expect(screen.getByText(en.partial)).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.rebuild })).toBeNull()
  fireEvent.click(screen.getByText(en.events))
  expect(screen.getByText('2026-01-01T00:00:00Z', { selector: 'time' })).toBeTruthy()
})
it('reports an unknown write result without claiming the action succeeded', async () => {
  const h = fixture(en)
  const props = { ...h.props, act: async () => ({ status: 'uncertain' as const, code: 'admin-outcome-unknown' }) }
  render(<NodesSection {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.rebuild }))
  fireEvent.click(screen.getByRole('button', { name: en.confirm }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(en.uncertain) })
  expect(screen.queryByText(en.actionSuccess)).toBeNull()
})
