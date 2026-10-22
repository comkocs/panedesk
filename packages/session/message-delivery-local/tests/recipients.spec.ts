import { describe, expect, it } from 'vitest'
import { SessionId } from '@panedesk/dsh-session'
import type { NodeId } from '@panedesk/dsh-message-delivery'
import { policyReason, resolveRecipients } from '../src/recipients.ts'
import type { RecipientMetadata } from '../src/types.ts'

const node = 'node-a' as NodeId
const metadata: RecipientMetadata[] = [
  { sessionId: SessionId('seat-a'), title: 'alpha', window: 'window-a', archived: false, settings: { receiveMode: 'all', wakeOnHandoff: true } },
  { sessionId: SessionId('seat-b'), title: 'window-a', window: 'window-b', archived: false, settings: { receiveMode: 'all', wakeOnHandoff: true } },
  { sessionId: SessionId('seat-c'), title: 'archived', window: null, archived: true, settings: { receiveMode: 'all', wakeOnHandoff: true } },
]

describe('exact recipient resolution', () => {
  it('combines both fields, rejects ambiguity and retains candidate match details', async () => {
    const [result] = await resolveRecipients(node, [{ name: ' window-a ' }], metadata, async () => 'idle')
    expect(result).toMatchObject({ kind: 'rejected', reason: 'target-ambiguous', candidates: [
      { sessionId: 'seat-a', matchedFields: ['window'] }, { sessionId: 'seat-b', matchedFields: ['title'] },
    ] })
  })
  it('resolves ids directly and performs neither prefix nor case folding', async () => {
    const results = await resolveRecipients(node, [{ sessionId: SessionId('seat-a') }, { name: 'alp' }, { name: 'Alpha' }], metadata, async () => 'busy')
    expect(results[0]).toMatchObject({ kind: 'resolved', recipient: { sessionId: 'seat-a', status: 'busy', matchedFields: ['sessionId'] } })
    expect(results.slice(1)).toMatchObject([{ reason: 'target-not-found' }, { reason: 'target-not-found' }])
  })
  it('deduplicates dual matches in one session and excludes archived candidates', async () => {
    const results = await resolveRecipients(node, [{ name: 'alpha' }, { name: 'archived' }],
      [{ ...metadata[0], sessionId: SessionId('seat-a'), title: 'alpha', window: 'alpha', archived: false,
        settings: { receiveMode: 'all', wakeOnHandoff: true } }, ...metadata.slice(1)], async () => 'closed')
    expect(results[0]).toMatchObject({ kind: 'resolved', recipient: { matchedFields: ['window', 'title'], status: 'closed' } })
    expect(results[1]).toMatchObject({ kind: 'rejected', reason: 'target-archived', candidates: [] })
  })
  it('fails closed for unknown liveness and refuses cross-node resolution', async () => {
    const results = await resolveRecipients(node, [{ name: 'alpha' }, { nodeId: 'node-b' as NodeId, name: 'alpha' }], metadata, async () => 'unavailable')
    expect(results).toMatchObject([{ reason: 'unavailable' }, { reason: 'cross-node-unsupported' }])
  })
  it('admits replies under handoff-only and refuses notices and disabled reception', () => {
    expect(policyReason({ receiveMode: 'handoff-only', wakeOnHandoff: false }, 'reply')).toBeUndefined()
    expect(policyReason({ receiveMode: 'handoff-only', wakeOnHandoff: true }, 'notice')).toBe('handoff-only')
    expect(policyReason({ receiveMode: 'none', wakeOnHandoff: true }, 'reply')).toBe('receive-disabled')
  })
})
