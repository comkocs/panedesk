// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { MessageState, MessageStatus } from '@panedesk/dsh-message-delivery'
import type { InboxView } from '../src/types.ts'
import { InboxPanel } from '../src/client/panel.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const states: readonly MessageState[] = ['queued', 'injected', 'responded', 'withdrawn', 'invalidated', 'rejected']
const items = states.map((state, index) => ({ senderSeat: `sender-${index}`, status: {
  messageId: `message-${index}` as MessageStatus['messageId'], state, phase: 'settled' as const, revision: 1, stateVersion: 1,
  transitions: [], metadata: { senderSessionId: 'sender' as never, targetSessionId: 'receiver' as never,
    priority: 'steer' as const, createdAt: Date.parse('2026-01-01T00:00:00Z') + index },
} }))
function props(locale: typeof en, value: InboxView | undefined,
  status = 'live', code?: string, preset = 'standard') {
  const sessionId = items[0]!.status.metadata.targetSessionId
  const sessions: Parameters<Parameters<ComponentProps<typeof InboxPanel>['useSessions']>[0]>[0] = { ids: [sessionId], byId: { [sessionId]: {
    id: sessionId, displayTitle: 'Receiver', running: false, retainedBy: {}, blank: false, updatedAt: 0,
    projectionValues: { agentPreset: preset },
  } }, phase: 'ready', projectionsBySession: {} }
  const useSessions: ComponentProps<typeof InboxPanel>['useSessions'] = select => select(sessions)
  const view = {
    sessionId: 'receiver',
    useSessions,
    useResource: () => ({ status, value, ...(code ? { failure: { code, name: 'Error', message: code, isDSHRemoteError: true as const } } : {}) }),
    t: (key: keyof typeof en, args?: Record<string, string | number>) => Object.entries(args ?? {})
      .reduce((text, [name, argument]) => text.replaceAll(`{${name}}`, String(argument)), locale[key]),
  }
  return view as ComponentProps<typeof InboxPanel>
}
it.each([en, zh])('shows all existing message states and the received metadata columns in both locales', (locale) => {
  render(<InboxPanel {...props(locale, { enabled: true, items, quarantined: [], complete: true })} />)
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: locale.title }))
  for (const state of states) expect(screen.getByText(locale[state])).toBeTruthy()
  for (const field of ['sender', 'time', 'priority', 'state'] as const) expect(screen.getByRole('columnheader', { name: locale[field] })).toBeTruthy()
  expect(screen.getByText('sender-0')).toBeTruthy()
  expect(screen.getAllByText(locale.steer)).toHaveLength(6)
  expect(screen.getByText('2026-01-01T00:00:00.000Z')).toBeTruthy()
})
it.each([en, zh])('keeps the minimal preset header free of inbox and isolation controls', (locale) => {
  const value: InboxView = { enabled: true, items, complete: true, quarantined: [{
    cursor: 'isolation-a' as never, nodeId: 'node-a' as never, observedAt: 0, originalFileName: 'record.json', reason: 'corrupt',
  }] }
  render(<InboxPanel {...props(locale, value, 'live', undefined, 'minimal')} />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})
it.each([en, zh])('shows isolation only when evidence exists and reveals its localized reason', (locale) => {
  const value: InboxView = { enabled: true, items: [], complete: true, quarantined: [{
    cursor: 'isolation-a' as never, nodeId: 'node-a' as never, observedAt: 0, originalFileName: 'record.json', reason: 'corrupt',
  }] }
  render(<InboxPanel {...props(locale, value)} />)
  fireEvent.click(screen.getByRole('button', { name: locale.quarantine.replace('{count}', '1') }))
  expect(screen.getByText(locale.corrupt)).toBeTruthy()
  expect(screen.getByRole('dialog', { name: locale.reasons })).toBeTruthy()
})
it.each([
  ['idle', undefined, 'idle', undefined], ['loading', undefined, 'loading', undefined],
  ['live', { enabled: true, items: [], quarantined: [], complete: true }, 'empty', undefined],
  ['live', { enabled: true, items, quarantined: [], complete: false }, 'partial', undefined],
  ['failed', undefined, 'error', undefined], ['failed', undefined, 'unauthorized', 'inbox/unauthorized'],
  ['live', { enabled: false, items: [], quarantined: [], complete: true }, 'disabled', undefined],
  ['live', { enabled: true, items, quarantined: [], complete: true }, 'success', undefined],
  ['failed', { enabled: true, items, quarantined: [], complete: true }, 'failed', undefined],
] as const)('handles %s / %s as %s', (status, value, key, code) => {
  render(<InboxPanel {...props(en, value, status, code)} />)
  fireEvent.click(screen.getByRole('button', { name: en.title }))
  expect(screen.getByText(en[key])).toBeTruthy()
})
