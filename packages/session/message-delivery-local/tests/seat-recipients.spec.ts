import { describe, expect, it } from 'vitest'
import { SessionId } from '@panedesk/dsh-session'
import type { NodeId } from '@panedesk/dsh-message-delivery'
import type { SeatMessageWindow, SeatNodeId } from '@panedesk/dsh-seat'
import { resolveSeatRecipient } from '../src/recipients.ts'

const nodeId = 'node-a' as NodeId
const rows: SeatMessageWindow[] = [
  { seat: 'alpha', sessionId: SessionId('old'), nodeId: 'node-a' as SeatNodeId, primary: false },
  { seat: 'alpha', sessionId: SessionId('main'), nodeId: 'node-a' as SeatNodeId, primary: true },
]
const metadata = rows.map(row => ({ sessionId: row.sessionId, title: row.sessionId, window: null,
  archived: false, settings: { receiveMode: 'all' as const, wakeOnHandoff: true } }))

describe('explicit local seat recipients', () => {
  it('selects the current primary without changing title addressing', async () => {
    expect(await resolveSeatRecipient(nodeId, ' alpha ', rows, metadata, async () => 'busy'))
      .toMatchObject({ kind: 'resolved', recipient: { sessionId: 'main', status: 'busy' } })
  })
  it('rejects an unopened or closed seat instead of retaining pending mail', async () => {
    expect(await resolveSeatRecipient(nodeId, 'missing', rows, metadata, async () => 'idle'))
      .toMatchObject({ kind: 'rejected', detail: 'seat not open' })
    expect(await resolveSeatRecipient(nodeId, 'alpha', rows, metadata, async () => 'closed'))
      .toMatchObject({ kind: 'rejected', detail: 'seat not open' })
  })
  it('retains ambiguity details and does not guess the newest window', async () => {
    expect(await resolveSeatRecipient(nodeId, 'alpha', rows.map(row => ({ ...row, primary: false })), metadata, async () => 'idle'))
      .toMatchObject({ kind: 'rejected', reason: 'target-ambiguous', detail: 'seat has no unique primary window',
        candidates: [{ sessionId: 'old' }, { sessionId: 'main' }] })
  })
  it('rejects unknown liveness, remote rows and wildcard names', async () => {
    expect(await resolveSeatRecipient(nodeId, 'alpha', rows, metadata, async () => 'unavailable'))
      .toMatchObject({ kind: 'rejected', reason: 'unavailable' })
    expect(await resolveSeatRecipient(nodeId, 'alpha', rows.map(row => ({ ...row, nodeId: 'node-b' as SeatNodeId })), metadata, async () => 'idle'))
      .toMatchObject({ kind: 'rejected', detail: 'seat not open' })
    expect(await resolveSeatRecipient(nodeId, '*', rows, metadata, async () => 'idle'))
      .toMatchObject({ kind: 'rejected', detail: 'one exact seat is required' })
  })
})
