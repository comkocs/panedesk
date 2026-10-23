/** Session-local subscription sets preserve catalog order and canonical deduplication. */
import type { SeatDefinition } from '@panedesk/dsh-seat'
import type { Agent } from '@panedesk/dsh-agent'
import { canonicalPath } from './identity.ts'

/** Public registration signature consumed from the installed subscription provider. */
export interface SessionSubscriptionRegistry {
  register(agent: Agent, files: readonly string[]): Promise<() => Promise<void>>
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

/** Await subscription registration before opening delivery; the owning instance disposes it.
 * @param registry - optional subscription provider.
 * @param agent - Session instance owning the subscriptions.
 * @param files - canonical file paths.
 * @returns asynchronous disposer after registration succeeds.
 */
export async function registerSubscriptions(registry: SessionSubscriptionRegistry | undefined,
  agent: Agent, files: readonly string[]): Promise<() => Promise<void>> {
  if (registry === undefined) throw new Error('Session subscription registration is unavailable')
  return registry.register(agent, files)
}
