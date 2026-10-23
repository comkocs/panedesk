/** Session-local subscription sets preserve catalog order and canonical deduplication. */
import type { SeatDefinition } from '@panedesk/dsh-seat'
import type { SessionId } from '@panedesk/dsh-session'
import { canonicalPath } from './identity.ts'

/** Public registration signature consumed from the installed subscription provider. */
export interface SessionSubscriptionRegistry {
  registerForSession(request: { sessionId: SessionId; files: readonly string[]; operationId: string }): Promise<void>
}

/** Include discovered instructions, explicit opening pointers and separately configured subscriptions.
 * @param definition - frozen definition.
 * @param discovered - rules actually loaded for startup and additional roots.
 * @returns canonical unique files in first-observed order.
 */
export async function subscriptionFiles(definition: SeatDefinition, discovered: readonly string[]): Promise<string[]> {
  const files = [...discovered, ...(definition.opening.kind === 'file' ? [definition.opening.path] : []),
    ...definition.openingInstructionFiles, ...definition.subscriptions]
  return [...new Set(await Promise.all(files.map(file => canonicalPath(file))))]
}

/** Wait for registration before opening delivery; absence is an explicit configuration failure.
 * @param registry - optional upstream provider.
 * @param request - fixed operation and session-owned files.
 * @returns after all files are registered.
 */
export async function registerSubscriptions(registry: SessionSubscriptionRegistry | undefined,
  request: Parameters<SessionSubscriptionRegistry['registerForSession']>[0]): Promise<void> {
  if (registry === undefined) throw new Error('Session subscription registration is unavailable')
  await registry.registerForSession(request)
}
