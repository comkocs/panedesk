/** Adapt an owned priority scheduler to the shared interactive queue controls. */
import { mutateAgentQueue, type Agent, type AgentInputScheduler } from '@panedesk/dsh-agent'
import type { DeliveryDriver } from './types.ts'
import { MailboxUnavailableError } from './files.ts'

/**
 * Bind delivery to a live scheduler without restoring or opening a Session.
 * @param agent - current owner of the target queue.
 * @returns the delivery adapter, or undefined for a legacy driver.
 */
export function deliveryDriver(agent: Agent): DeliveryDriver | undefined {
  if (!('enqueue' in agent) || typeof agent.enqueue !== 'function' || !('hasRunnable' in agent)) return undefined
  const scheduler = agent as Agent & AgentInputScheduler
  return {
    agent,
    get hasRunnable() { return scheduler.hasRunnable },
    enqueue: (input, options) => { scheduler.enqueue(input, options) },
    mutate: (id, action) => {
      const result = mutateAgentQueue(agent, id, action.kind === 'edit'
        ? { kind: 'edit', content: action.message.content.filter(block => block.type === 'text') }
        : action)
      if (result.kind === 'unsupported') throw new MailboxUnavailableError('Priority queue mutation is unavailable')
      return result.kind === 'applied'
    },
  }
}
