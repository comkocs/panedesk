/** Exact dual-field addressing; resolution never opens an Agent or writes a mailbox. */
import type { MessageAddress, MessageRecipient, MessageSettings, NodeId, ResolvedRecipient } from '@panedesk/dsh-message-delivery'
import type { RecipientMetadata } from './types.ts'

/** Resolve an explicit list against one metadata cut and verified runtime liveness.
 * @param nodeId - this node, not a network address.
 * @param addresses - caller's exact ids or trimmed names.
 * @param metadata - Session-backed titles, archive state, and policies.
 * @param status - PID-incarnation-aware runtime status reader.
 * @returns one independent result for each address.
 */
export async function resolveRecipients(
  nodeId: NodeId,
  addresses: readonly MessageAddress[],
  metadata: readonly RecipientMetadata[],
  status: (sessionId: string) => Promise<'busy' | 'idle' | 'closed' | 'unavailable'>,
): Promise<ResolvedRecipient[]> {
  const results: ResolvedRecipient[] = []
  for (const address of addresses) {
    if (address.nodeId !== undefined && address.nodeId !== nodeId) {
      results.push({ kind: 'rejected', address, reason: 'cross-node-unsupported', candidates: [] })
      continue
    }
    const matches = new Map<string, { metadata: RecipientMetadata; fields: ('sessionId' | 'window' | 'title')[] }>()
    for (const item of metadata) {
      const fields: ('sessionId' | 'window' | 'title')[] = []
      if (address.sessionId !== undefined) {
        if (address.sessionId === item.sessionId) fields.push('sessionId')
      } else {
        const name = address.name.trim()
        if (name.length > 0 && item.window?.trim() === name) fields.push('window')
        if (name.length > 0 && item.title?.trim() === name) fields.push('title')
      }
      if (fields.length > 0) matches.set(item.sessionId, { metadata: item, fields })
    }
    const active = [...matches.values()].filter(item => !item.metadata.archived)
    const candidates: MessageRecipient[] = []
    let unavailable = false
    for (const item of active) {
      const state = await status(item.metadata.sessionId)
      if (state === 'unavailable') { unavailable = true; continue }
      candidates.push({ nodeId, sessionId: item.metadata.sessionId, window: item.metadata.window,
        title: item.metadata.title, status: state, matchedFields: item.fields, observedAt: Date.now() })
    }
    const [recipient] = candidates
    if (unavailable) results.push({ kind: 'rejected', address, reason: 'unavailable', candidates })
    else if (candidates.length === 1 && recipient) results.push({ kind: 'resolved', address, recipient })
    else results.push({ kind: 'rejected', address, reason: candidates.length > 1 ? 'target-ambiguous'
      : matches.size > 0 ? 'target-archived' : 'target-not-found', candidates })
  }
  return results
}

/** Check admission before storing a new send; replies count as handoffs.
 * @param settings - complete persisted Session settings.
 * @param messageClass - classification of the new send.
 * @returns structured refusal, or undefined when admitted.
 */
export function policyReason(settings: MessageSettings, messageClass: 'handoff' | 'notice' | 'reply'): 'receive-disabled' | 'handoff-only' | undefined {
  if (settings.receiveMode === 'none') return 'receive-disabled'
  if (settings.receiveMode === 'handoff-only' && messageClass === 'notice') return 'handoff-only'
  return undefined
}
