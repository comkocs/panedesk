/** Closed seat message decoding preserves frozen identity without interpreting seat names as sessions. */
import { digest, identifier, object } from '@panedesk/dsh-host-admin'
import type { OnlineSeat, OnlineSeatsRequest, RoutedSeatMessageRequest } from '@panedesk/dsh-message-delivery'
import { decodeRoutedSend } from './routed-codec.ts'

/** Validate one exact seat and all original message identities.
 * @param value - Untrusted wire or retained request.
 * @returns Validated request without resolving or replacing its target.
 */
export function decodeRoutedSeatSend(value: unknown): RoutedSeatMessageRequest {
  if (!object(value) || !object(value.target) || !identifier(value.target.nodeId)
    || typeof value.target.seat !== 'string' || !value.target.seat.trim() || value.target.seat !== value.target.seat.trim()
    || /[*?]/.test(value.target.seat) || Object.keys(value.target).some(key => !['nodeId', 'seat'].includes(key))
    || !object(value.delivery) || !object(value.delivery.message) || !object(value.delivery.message.target)
    || digest(value.delivery.message.target) !== digest(value.target)) throw new Error('Seat delivery target rejected')
  if (Object.keys(value).some(key => !['target', 'operationId', 'content', 'messageClass', 'priority', 'replyTo', 'delivery'].includes(key))) {
    throw new Error('Seat delivery fields rejected')
  }
  const { delivery, target, ...request } = value
  const { digest: fingerprint, ...envelope } = delivery
  if (fingerprint !== digest(envelope)) throw new Error('Seat delivery digest rejected')
  // Reuse identity validation with a fixed validation-only address; no transformed value escapes.
  const address = { nodeId: target.nodeId, sessionId: 'seat-validation' }
  const translated = { ...envelope, message: { ...value.delivery.message, target: address } }
  decodeRoutedSend({ ...request, target: address, delivery: { ...translated, digest: digest(translated) } })
  return value as RoutedSeatMessageRequest
}
/** Validate the closed read-only query fields.
 * @param value - Untrusted query.
 * @returns Exact observation request.
 */
export function decodeOnlineSeatsRequest(value: unknown): OnlineSeatsRequest {
  if (!object(value) || !identifier(value.operationId) || Object.keys(value).some(key => key !== 'operationId')) {
    throw new Error('Online seat query rejected')
  }
  return { operationId: value.operationId as OnlineSeatsRequest['operationId'] }
}
/** Validate a complete local observation; transport enforces the complete frame byte limit.
 * @param value - Peer observation.
 * @returns Verified busy/idle rows, never a delivery reservation.
 */
export function decodeOnlineSeats(value: unknown): readonly OnlineSeat[] {
  if (!Array.isArray(value) || !value.every(row => object(row) && typeof row.seat === 'string' && row.seat.trim()
    && identifier(row.nodeId) && identifier(row.sessionId) && ['busy', 'idle'].includes(String(row.status))
    && typeof row.primary === 'boolean'
    && Object.keys(row).every(key => ['seat', 'nodeId', 'sessionId', 'status', 'primary'].includes(key)))) {
    throw new Error('Online seat observation rejected')
  }
  return value as OnlineSeat[]
}
