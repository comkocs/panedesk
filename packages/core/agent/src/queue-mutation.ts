/** Shared synchronous queue controls for an already-owned live agent; never restores a session. */
import type { Agent, InputPriority } from './types.ts'
import type { AgentInputScheduler } from './runtime-types.ts'
import type { MessageId, TextBlock } from '@panedesk/dsh-llm'
import { freezeMessage } from '@panedesk/dsh-llm'

/** Generic mutation independent of transport admission and session activation. */
export type QueueMutation =
  | { readonly kind: 'remove' }
  | { readonly kind: 'edit'; readonly content: readonly TextBlock[] }
  | { readonly kind: 'steer' }
  | { readonly kind: 'reprioritize'; readonly priority: InputPriority }

/** Structured admission result; claimed and injected cannot be mistaken for missing input. */
export type QueueMutationResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'claimed' | 'injected' | 'missing' | 'unsupported' | 'steer-unavailable' }

/**
 * Apply a queue control to an owned agent without opening or waking a cold session.
 * @param agent - current owner of the target queue.
 * @param id - input identity.
 * @param action - synchronous mutation.
 * @returns the committed result or a structured refusal.
 */
export function mutateAgentQueue(agent: Agent, id: MessageId, action: QueueMutation): QueueMutationResult {
  const state = agent.inbox.inputState?.(id)
  if (state === 'claimed' || state === 'injected') return { kind: state }
  const queued = agent.inbox.nextTurn.find(message => message.id === id)
  const message = queued ?? agent.inbox.nextStep.find(message => message.id === id)
  if (message === undefined) return { kind: 'missing' }
  switch (action.kind) {
    case 'remove':
      return { kind: agent.inbox.remove(id) ? 'applied' : 'missing' }
    case 'edit':
      return { kind: agent.inbox.replace(id, freezeMessage({ ...message, content: [...action.content] })) ? 'applied' : 'missing' }
    case 'steer':
      if (queued === undefined || agent.status !== 'running') return { kind: 'steer-unavailable' }
      agent.inbox.remove(id)
      agent.steer(message)
      return { kind: 'applied' }
    case 'reprioritize': {
      if (!('reprioritize' in agent) || typeof agent.reprioritize !== 'function') return { kind: 'unsupported' }
      const scheduler = agent as Agent & AgentInputScheduler
      return { kind: scheduler.reprioritize?.(id, action.priority) ? 'applied' : 'missing' }
    }
  }
}
