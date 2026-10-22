/** Explicit-list delivery keeps recipient failures independent and previews read-only. */
import type { MessageAddress, MessageSettings, ResolvedRecipient, SendBatchRequest, SendBatchResult, SendMessageRequest, SendMessageResult } from '@panedesk/dsh-message-delivery'
import type { SessionId } from '@panedesk/dsh-session'
import { policyReason } from './recipients.ts'
import { MailboxUnavailableError } from './files.ts'

/** Resolve, deduplicate, then preview policy or send independently.
 * @param request - explicit recipients and their retained operation identities.
 * @param limit - configured maximum number of supplied addresses.
 * @param resolve - read-only address resolver.
 * @param settings - authoritative policy reader.
 * @param send - single-target durable sender, which revalidates admission.
 * @returns independent results for unique resolved Sessions and unresolved addresses.
 */
export async function broadcast(request: SendBatchRequest, limit: number,
  resolve: (addresses: readonly MessageAddress[]) => Promise<ResolvedRecipient[]>,
  settings: (id: SessionId) => Promise<MessageSettings>,
  send: (request: SendMessageRequest) => Promise<SendMessageResult>,
): Promise<SendBatchResult> {
  if (request.recipients.length > limit) throw new MailboxUnavailableError('Recipient list exceeds limit')
  const resolutions = await resolve(request.recipients.map(item => item.target))
  const seen = new Set<SessionId>()
  const retained = resolutions.flatMap((result, index) => {
    if (result.kind === 'resolved') {
      if (seen.has(result.recipient.sessionId)) return []
      seen.add(result.recipient.sessionId)
    }
    const item = request.recipients[index]
    if (!item) throw new MailboxUnavailableError('Resolved recipient lost its operation identity')
    return [{ result, item }]
  })
  if (request.dryRun) {
    const recipients: ResolvedRecipient[] = []
    for (const { result } of retained) {
      if (result.kind === 'rejected') { recipients.push(result); continue }
      const reason = policyReason(await settings(result.recipient.sessionId), request.messageClass)
      recipients.push(reason ? { kind: 'rejected', address: result.address, reason, candidates: [result.recipient] } : result)
    }
    return { kind: 'resolved', recipients }
  }
  const results: SendMessageResult[] = []
  for (const { item } of retained) {
    results.push(await send({ ...request, target: item.target, operationId: item.operationId }))
  }
  return { kind: 'sent', results }
}
