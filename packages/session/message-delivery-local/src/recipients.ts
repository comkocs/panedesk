/** Exact dual-field addressing; resolution never opens an Agent or writes a mailbox. */
import type { MessageAddress, MessageRecipient, MessageSettings, NodeId, ResolvedRecipient } from '@panedesk/dsh-message-delivery'
import type { RecipientMetadata } from './types.ts'
import type { SeatMessageWindow } from '@panedesk/dsh-seat'
import type { SeatRecipientResolution } from '@panedesk/dsh-message-delivery'

/** Resolve a seat only against committed local bindings and verified live registrations.
 * @param nodeId - owning mailbox node.
 * @param seat - exact trimmed seat name.
 * @param windows - complete local seat projection.
 * @param metadata - current Session archive and title metadata.
 * @param status - verified process-incarnation liveness reader.
 * @returns one primary target or refusal with candidate details; never opens a closed seat.
 */
export async function resolveSeatRecipient(nodeId: NodeId, seat: string, windows: readonly SeatMessageWindow[],
  metadata: readonly RecipientMetadata[],
  status: (sessionId: string) => Promise<'busy' | 'idle' | 'closed' | 'unavailable'>,
): Promise<SeatRecipientResolution> {
  seat = seat.trim()
  const reject = (reason: import('@panedesk/dsh-message-delivery').MessageReason, detail: string,
    candidates: readonly MessageRecipient[] = []): SeatRecipientResolution => ({ kind: 'rejected', seat, reason, detail, candidates })
  if (!seat || /[*?]/.test(seat)) return reject('target-not-found', 'one exact seat is required')
  const selected = windows.filter(window => window.nodeId === nodeId && window.seat === seat)
  const resolutions = await resolveRecipients(nodeId, selected.map(window => ({ sessionId: window.sessionId })), metadata, status)
  const candidates = resolutions.flatMap(result => result.kind === 'resolved' && result.recipient.status !== 'closed' ? [result.recipient] : [])
  if (resolutions.some(result => result.kind === 'rejected' && result.reason === 'unavailable')) {
    return reject('unavailable', 'seat runtime liveness is unavailable', candidates)
  }
  if (!candidates.length) return reject('target-not-found', 'seat not open')
  const primary = candidates.filter(candidate => selected.some(window => window.sessionId === candidate.sessionId && window.primary))
  const recipient = selected.length === 1 ? candidates[0] : primary.length === 1 ? primary[0] : undefined
  return recipient ? { kind: 'resolved', seat, recipient }
    : reject('target-ambiguous', 'seat has no unique primary window', candidates)
}

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
