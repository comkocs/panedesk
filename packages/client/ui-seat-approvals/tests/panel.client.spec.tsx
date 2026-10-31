// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type * as Seat from '@panedesk/dsh-seat'
import { RemoteError } from '@panedesk/dsh-typert-protocol'
import type { ApprovalActions } from '../src/client/index.ts'
import { ApprovalPanel } from '../src/client/panel.tsx'
import { en, zh } from '../src/client/locales.ts'
import { ApprovalObservations } from '../src/client/observations.ts'

afterEach(cleanup)
const pending: Seat.PendingSeatItem = { queueItemId: 'queue-a' as Seat.QueueItemId, seat: 'seat-a' as Seat.SeatName,
  projectId: 'project-a' as Seat.SeatProjectId, triggerKind: 'external', action: 'open', sequence: 1,
  effectiveMode: 'remind', reason: 'approval', blockedBy: [], sources: [], relatedTaskIds: ['task-a' as Seat.SeatTaskId],
  queuedAt: '2026-01-01T00:00:00Z', stateVersion: 7, windowName: 'Frozen title', nodeId: 'node-a' as Seat.SeatNodeId,
  budget: { windowBudgetUsd: '0' as Seat.MicroUsd, dailyBudgetUsd: '2500000' as Seat.MicroUsd } }
const operationId = 'approval-a' as Seat.SeatOperationId

function props(
  items: readonly Seat.PendingSeatObservation[] = [pending], operation?: Seat.SeatEngineOperationResult,
  complete = true, locale: typeof en = en,
) {
  const mutate = vi.fn<ApprovalActions['mutate']>(async () =>
    ({ operationId, result: { ok: true, value: { status: 'approved', queueItemId: pending.queueItemId, stateVersion: 8 } } }))
  const observations = new ApprovalObservations()
  const view = { mutate,
    t: (key: keyof typeof en, args?: Record<string, string | number>) => Object.entries(args ?? {})
      .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), locale[key]),
    useResource: (address: string) => address.includes('seat-approval-operation')
      ? { status: 'live', value: operation } : { status: 'live', value: observations.observe({ enabled: true, items, complete }) },
  }
  return { view: view as ComponentProps<typeof ApprovalPanel>, mutate }
}

it.each([
  [en, '1 windows ready for approval', 'Temporarily retained', '300000 ms remaining', 'Retention expires within five minutes: seat-a'],
  [zh, '可开 1 窗', '暂态保留中', '剩余 300000 毫秒', '五分钟内到限：seat-a'],
])('shows projected retention and alerts without calculating a client deadline', (locale, entry, state, remaining, alert) => {
  const item = { ...pending, reason: 'provider-unavailable' as const,
    retention: { since: 0, deadline: 900000, remainingMs: 300000, phase: 'expiring' as const } }
  render(<ApprovalPanel {...props([item], undefined, true, locale).view} />)
  expect(screen.getByRole('alert').textContent).toBe(alert)
  fireEvent.click(screen.getByRole('button', { name: entry }))
  expect(screen.getByText(state)).toBeTruthy()
  expect(screen.getByText(remaining)).toBeTruthy()
  expect(screen.getByRole('button', { name: locale.approve }).hasAttribute('disabled')).toBe(true)
})

it.each([en, zh])('keeps threshold alerts once across modal reopenings and shows committed refusal', (locale) => {
  const observations = new ApprovalObservations()
  const item: Seat.PendingSeatObservation = { ...pending, reason: 'provider-unavailable',
    retention: { since: 0, deadline: 900000, remainingMs: 300000, phase: 'expiring' } }
  let queue = observations.observe({ enabled: true, items: [item], complete: true })
  const view = { ...props([], undefined, true, locale).view, useResource: () => ({ status: 'live', value: queue }) }
  const rendered = render(<ApprovalPanel {...view as ComponentProps<typeof ApprovalPanel>} />)
  const first = screen.getByRole('alert')
  for (let index = 0; index < 2; index++) {
    fireEvent.click(screen.getByRole('button', { name: locale.available.replace('{count}', '1') }))
    fireEvent.click(screen.getByRole('button', { name: locale.close }))
    expect(screen.getByRole('alert')).toBe(first)
  }
  const error: Seat.SeatFailure = { code: 'gate-denied', message: 'Pre-open retention limit reached',
    alternative: 'Submit a new operation', retryable: false, effectState: 'none' }
  queue = observations.observe({ enabled: true, items: [], complete: true, rejected: [{ item: pending, error }] })
  rendered.rerender(<ApprovalPanel {...view as ComponentProps<typeof ApprovalPanel>} />)
  const alerts = screen.getAllByRole('alert')
  expect(alerts).toHaveLength(2)
  expect(alerts[0]).toBe(first)
  expect(alerts[1]?.textContent).toBe(locale.expired.replace('{seat}', 'seat-a'))
  fireEvent.click(screen.getByRole('button', { name: locale.available.replace('{count}', '0') }))
  expect(screen.getByText(locale.terminal.replace('{code}', error.code).replace('{message}', error.message))).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: locale.close }))
  fireEvent.click(screen.getByRole('button', { name: locale.available.replace('{count}', '0') }))
  expect(screen.getAllByRole('alert')).toEqual(alerts)
})

it('hides the zero-count entry and shows the exact pending count', () => {
  const empty = props([])
  const rendered = render(<ApprovalPanel {...empty.view} />)
  expect(screen.queryByRole('button')).toBeNull()
  rendered.rerender(<ApprovalPanel {...props().view} />)
  expect(screen.getByRole('button', { name: '1 windows ready for approval' })).toBeTruthy()
})

it('shows frozen metadata and passes the exact observed version through the mutation action', async () => {
  const h = props()
  render(<ApprovalPanel {...h.view} />)
  fireEvent.click(screen.getByRole('button', { name: '1 windows ready for approval' }))
  for (const text of ['seat-a', 'task-a', 'Frozen title', 'node-a', 'Window 0 micro-USD; Daily 2500000 micro-USD']) {
    expect(screen.getByText(text)).toBeTruthy()
  }
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() => { expect(h.mutate).toHaveBeenCalledWith(pending, 'approve') })
  expect(screen.queryByText('Opening completed')).toBeNull()
  await waitFor(() => { expect(screen.getAllByText('Approval recorded. Waiting for an actual window.').length).toBeGreaterThan(0) })
})

it('renders all four fields from actual opening evidence instead of the frozen preview', async () => {
  const operation: Seat.SeatEngineOperationResult = { status: 'settled', result: { status: 'opened', sessionId: 'session-a' as never,
    seat: 'actual-seat' as Seat.SeatName, nodeId: 'actual-node' as Seat.SeatNodeId, nodeName: 'Actual node', title: 'Actual title',
    budget: { windowBudgetUsd: '1000000' as Seat.MicroUsd }, phase: 'active', stateVersion: 9, callbackIds: [] } }
  const h = props([pending], operation)
  render(<ApprovalPanel {...h.view} />)
  fireEvent.click(screen.getByRole('button', { name: '1 windows ready for approval' }))
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() => { expect(screen.getByText('Opening completed')).toBeTruthy() })
  for (const text of ['actual-seat', 'Actual title', 'Actual node', 'Window 1000000 micro-USD']) expect(screen.getByText(text)).toBeTruthy()
})

it.each([
  ['English', en, '1 windows ready for approval', 'Approve', 'Unlimited'],
  ['Chinese', zh, '可开 1 窗', '批准', '不限'],
])('shows an unlimited opening budget in %s', async (_language, locale, entry, approve, unlimited) => {
  const operation: Seat.SeatEngineOperationResult = { status: 'settled', result: { status: 'opened', sessionId: 'session-a' as never,
    seat: 'actual-seat' as Seat.SeatName, nodeId: 'actual-node' as Seat.SeatNodeId, nodeName: 'Actual node', title: 'Actual title',
    budget: {}, phase: 'active', stateVersion: 9, callbackIds: [] } }
  render(<ApprovalPanel {...props([pending], operation, true, locale).view} />)
  fireEvent.click(screen.getByRole('button', { name: entry }))
  fireEvent.click(screen.getByRole('button', { name: approve }))
  await waitFor(() => { expect(screen.getByText(unlimited)).toBeTruthy() })
})

it.each([
  [{ windowBudgetUsd: '10' as Seat.MicroUsd }, 'Window 10 micro-USD'],
  [{ dailyBudgetUsd: '20' as Seat.MicroUsd }, 'Daily 20 micro-USD'],
  [{ windowBudgetUsd: '10' as Seat.MicroUsd, dailyBudgetUsd: '20' as Seat.MicroUsd }, 'Window 10 micro-USD; Daily 20 micro-USD'],
])('shows only supplied opening limits', async (budget, expected) => {
  const operation: Seat.SeatEngineOperationResult = { status: 'settled', result: { status: 'opened', sessionId: 'session-a' as never,
    seat: 'actual-seat' as Seat.SeatName, nodeId: 'actual-node' as Seat.SeatNodeId, nodeName: 'Actual node', title: 'Actual title',
    budget, phase: 'active', stateVersion: 9, callbackIds: [] } }
  render(<ApprovalPanel {...props([pending], operation).view} />)
  fireEvent.click(screen.getByRole('button', { name: '1 windows ready for approval' }))
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() => { expect(screen.getByText(expected)).toBeTruthy() })
  expect(screen.queryByText('Unlimited')).toBeNull()
})

it('shows the actual node name in the opening card', async () => {
  const operation: Seat.SeatEngineOperationResult = { status: 'settled', result: { status: 'opened', sessionId: 'session-a' as never,
    seat: 'actual-seat' as Seat.SeatName, nodeId: 'actual-node' as Seat.SeatNodeId, nodeName: 'Actual node', title: 'Actual title',
    budget: {}, phase: 'active', stateVersion: 9, callbackIds: [] } }
  render(<ApprovalPanel {...props([pending], operation).view} />)
  fireEvent.click(screen.getByRole('button', { name: '1 windows ready for approval' }))
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() => { expect(screen.getByText('Actual node')).toBeTruthy() })
})

it('keeps absent fields explicit and sends cancellation to the existing action', async () => {
  const { windowName: _windowName, nodeId: _nodeId, budget: _budget, ...legacy } = pending
  const h = props([legacy])
  render(<ApprovalPanel {...h.view} />)
  fireEvent.click(screen.getByRole('button', { name: '1 windows ready for approval' }))
  expect(screen.getAllByText('Not provided')).toHaveLength(3)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel pending' }))
  await waitFor(() => { expect(h.mutate).toHaveBeenCalledWith(legacy, 'cancel') })
})

it('shows a recorded post-approval failure rather than an opening success card', async () => {
  const h = props([pending], { status: 'settled', result: { status: 'rejected', error: { code: 'open-create-failed',
    message: 'Opening failed', alternative: 'Inspect the provider', effectState: 'none', retryable: false } } })
  render(<ApprovalPanel {...h.view} />)
  fireEvent.click(screen.getByRole('button', { name: '1 windows ready for approval' }))
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('Opening failed') })
  expect(screen.queryByText('Opening completed')).toBeNull()
})

it('keeps actual created fields visible while reporting a later startup failure', async () => {
  const h = props([pending], { status: 'settled', result: { status: 'opened', sessionId: 'session-a' as never,
    seat: 'actual-seat' as Seat.SeatName, nodeId: 'actual-node' as Seat.SeatNodeId, nodeName: 'Actual node', title: 'Actual title',
    budget: {}, phase: 'opening-failed', stateVersion: 9, callbackIds: [] } })
  render(<ApprovalPanel {...h.view} />)
  fireEvent.click(screen.getByRole('button', { name: '1 windows ready for approval' }))
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() => { expect(screen.getByText(en.openingFailed)).toBeTruthy() })
  expect(screen.getByText('Actual title')).toBeTruthy()
  expect(screen.queryByText('Opening completed')).toBeNull()
  expect(screen.queryByText(en.opening)).toBeNull()
})

it('disables approval when the queue observation is incomplete', () => {
  const h = props([pending], undefined, false)
  render(<ApprovalPanel {...h.view} />)
  fireEvent.click(screen.getByRole('button', { name: '1 windows ready for approval' }))
  expect(screen.getByRole('alert').textContent).toBe(en.partial)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled).toBe(true)
  expect(h.mutate).not.toHaveBeenCalled()
})

it('explains an expired approval rather than claiming it opened a window', async () => {
  const h = props()
  h.mutate.mockResolvedValue({ operationId, result: { ok: true, value: { status: 'rejected', error: {
    code: 'revision-conflict', message: 'Revision changed', alternative: 'Refresh the queue', effectState: 'none', retryable: false,
  } } } })
  render(<ApprovalPanel {...h.view} />)
  fireEvent.click(screen.getByRole('button', { name: '1 windows ready for approval' }))
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() => { expect(screen.getByText(en.stale)).toBeTruthy() })
  expect(screen.queryByText('Opening completed')).toBeNull()
})

it('retains the operation lookup and prevents resubmission after an unknown outcome', async () => {
  const h = props()
  h.mutate.mockResolvedValue({ operationId, result: { ok: false,
    error: new RemoteError('seat-approvals/unavailable', 'Disconnected', {}) } })
  render(<ApprovalPanel {...h.view} />)
  fireEvent.click(screen.getByRole('button', { name: '1 windows ready for approval' }))
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() => { expect(screen.getAllByText(en.unknown).length).toBeGreaterThan(0) })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  expect(h.mutate).toHaveBeenCalledTimes(1)
})
