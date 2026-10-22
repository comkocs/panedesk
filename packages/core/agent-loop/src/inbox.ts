/**
 * Driver-owned durable agent inbox projection and command facade.
 *
 * @module @panedesk/dsh-agent-loop/inbox
 */

import type { MessageId } from '@panedesk/dsh-llm'
import type { ProjectionDefinition } from '@panedesk/dsh-session-projection'
import type SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import type { Session, SessionEventMap, UserMessage } from '@panedesk/dsh-session'
import type {
  AgentEventDispatch,
  Inbox as InboxContract,
  InboxState,
  InboxTarget,
  InboxWireState,
  InputScheduling,
  InputTransition,
  InputClaimId,
} from '@panedesk/dsh-agent'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { brandString } from '@panedesk/dsh-brand'

type Claim = {
  transition: Extract<InputTransition, { phase: 'claimed' }>
  entries: { message: UserMessage; scheduling: InputScheduling; target: InboxTarget }[]
  appended: MessageId[]
}


/** Wire validation for pending agent input reconstructed from durable inbox splices. */
export const inboxProjectionSchema = z.object({
  'next-turn': z.array(z.custom<UserMessage>()).readonly(),
  'next-step': z.array(z.custom<UserMessage>()).readonly(),
}).readonly()

interface ScheduledInboxState extends InboxState {
  readonly scheduling: Readonly<Record<string, InputScheduling>>
  readonly sequence: number
  readonly order: Readonly<Record<string, number>>
  readonly claims: Readonly<Record<string, Claim>>
  readonly dispatched: readonly MessageId[]
}

const schedulingSchema = z.object({
  priority: z.enum(['immediate', 'steer', 'queue']),
  passive: z.boolean(),
  enqueueSequence: z.number().int().nonnegative(),
  earliestTurn: z.number().int().nonnegative(),
})

/** Standard fold that reconstructs pending input and rejects invalid durable splice history. */
export const inboxProjectionDefinition = {
  key: 'inbox',
  stateSchema: inboxProjectionSchema.unwrap().extend({
    scheduling: z.record(z.string(), schedulingSchema),
    sequence: z.number().int().nonnegative(),
    order: z.record(z.string(), z.number().int().nonnegative()),
    claims: z.record(z.string(), z.custom<Claim>()),
    dispatched: z.array(z.custom<MessageId>()).readonly(),
  }).readonly(),
  init: (): ScheduledInboxState => ({ 'next-turn': [], 'next-step': [], scheduling: {}, sequence: 0, order: {}, claims: {}, dispatched: [] }),
  apply(state: ScheduledInboxState, event) {
    if (event.type === 'agent/input/transition') {
      const transition = event.data
      if (transition.phase === 'scheduled') return state
      const claims = { ...state.claims }
      if (transition.phase === 'claimed') {
        const entries = (['next-step', 'next-turn'] as const).flatMap(target => state[target]
          .filter(message => transition.messageIds.includes(message.id))
          .map(message => ({
            message, target,
            scheduling: state.scheduling[message.id] ?? {
              priority: target === 'next-step' ? 'steer' as const : 'queue' as const,
              passive: false, enqueueSequence: state.order[message.id] ?? 0, earliestTurn: transition.turn,
            },
          })))
        claims[transition.claimId] = { transition, entries, appended: [] }
      } else if (transition.phase === 'dispatched' || transition.phase === 'rolled-back') {
        delete claims[transition.claimId]
      }
      return {
        ...state, claims,
        dispatched: transition.phase === 'dispatched' ? [...state.dispatched, ...transition.messageIds] : state.dispatched,
      }
    }
    if (event.type === 'user/message') {
      const entry = Object.entries(state.claims).find(([, claim]) => claim.transition.messageIds.includes(event.data.id))
      if (entry === undefined) return state
      const [id, claim] = entry
      return { ...state, claims: { ...state.claims, [id]: { ...claim, appended: [...claim.appended, event.data.id] } } }
    }
    if (event.type !== 'agent/inbox/spliced') return state
    const splice = event.data
    try {
      const inbox = state[splice.target]
      const removedCount = splice.removedCount ?? 0
      if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
        || !Number.isSafeInteger(removedCount) || removedCount < 0
        || splice.start + removedCount > inbox.length) {
        throw new Error('invalid inbox splice')
      }
      const next = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
      const ids = new Set<string>()
      for (const message of splice.target === 'next-turn'
        ? [...next, ...state['next-step']]
        : [...state['next-turn'], ...next]) {
        if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
        ids.add(message.id)
      }
      if (splice.scheduling !== undefined && splice.scheduling.length !== splice.inserted.length) {
        throw new Error('scheduling must match inserted messages')
      }
      const scheduling = { ...state.scheduling }
      let sequence = state.sequence
      const order = { ...state.order }
      for (const removed of inbox.slice(splice.start, splice.start + removedCount)) {
        delete scheduling[removed.id]
        delete order[removed.id]
      }
      for (const [index, message] of splice.inserted.entries()) {
        const policy = splice.scheduling?.[index]
        if (policy !== undefined) {
          scheduling[message.id] = schedulingSchema.parse(policy)
          sequence = Math.max(sequence, policy.enqueueSequence)
        } else {
          sequence++
        }
        order[message.id] = policy?.enqueueSequence ?? state.order[message.id] ?? sequence
      }
      return { ...state, [splice.target]: next, scheduling, sequence, order }
    } catch (error: unknown) {
      throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
    }
  },
  wire: {
    // The wire value is the fold state itself: every pending message already
    // round-trips the session log as lossless JSON. Only the static type
    // narrows to the JSON-safe projection table entry.
    viewSchema: inboxProjectionSchema as unknown as z.ZodType<InboxWireState>,
    view: (state: ScheduledInboxState) => ({
      'next-turn': state['next-turn'], 'next-step': state['next-step'],
    }) as unknown as InboxWireState,
  },
  stateVersion: 2,
} satisfies ProjectionDefinition<'inbox', ScheduledInboxState>

/**
 * Driver-owned durable Inbox implementation used by ReactLoopAgent and focused
 * provider tests.
 * @param projections - registry with the standard Inbox projection registered by AgentLoop.
 * @param session - session whose durable events store pending input.
 * @param dispatch - agent-scoped notifications for Inbox lifecycle events.
 */
export class ReactLoopInbox implements InboxContract {
  constructor(
    private readonly projections: SessionProjectionRegistry,
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch,
  ) {}

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.current()['next-turn']
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.current()['next-step']
  }

  /** Whether either pending-message list contains work. */
  get hasPending(): boolean {
    const state = this.current()
    return state['next-turn'].length > 0 || state['next-step'].length > 0
  }

  /** Passive input never drives a turn independently. */
  get hasRunnable(): boolean {
    const state = this.current()
    return [...state['next-turn'], ...state['next-step']].some(message => !state.scheduling[message.id]?.passive)
  }

  /**
   * Read explicit scheduling, leaving legacy inbox behavior distinguishable.
   * @param id - pending message identity.
   * @returns persisted policy, or undefined for legacy input.
   */
  schedulingOf(id: MessageId): InputScheduling | undefined {
    return this.current().scheduling[id]
  }

  /** Next host-assigned order, including legacy arrivals. */
  get nextSequence(): number {
    return this.current().sequence + 1
  }

  /**
   * Commit required scheduling facts before inserting scheduled input.
   * @param message - identified input.
   * @param scheduling - resolved admission policy.
   */
  enqueue(message: UserMessage, scheduling: InputScheduling): void {
    const target = scheduling.priority === 'queue' ? 'next-turn' : 'next-step'
    this.mutate(target, Infinity, 0, [message], false, [scheduling])
  }

  /** Durably cancel all pending input, clearing next-step before next-turn. */
  clear(): void {
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /**
   * Remove and return the complete batch proposed for one step.
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   * @returns next-step input followed by the queued turn, when requested.
   */
  claim(target: InboxTarget, turn: number, step?: number): UserMessage[] {
    const state = this.current()
    const reserve = (messages: readonly UserMessage[]): void => {
      if (step === undefined || messages.length === 0) return
      this.session.append('agent/input/transition', {
        phase: 'claimed', claimId: brandString<InputClaimId>(randomUUID()),
        messageIds: messages.map(message => message.id), turn, step,
      })
    }
    if (Object.keys(state.scheduling).length === 0) {
      reserve([...this.nextStep, ...(target === 'next-turn' ? this.nextTurn.slice(0, 1) : [])])
      const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
      if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false))
      for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
      return claimed
    }
    const rank = { immediate: 0, steer: 1, queue: 2 }
    const candidates = (['next-step', 'next-turn'] as const).flatMap(list => state[list].map(message => ({
      message, list, policy: state.scheduling[message.id],
    }))).filter(({ list, policy }) => policy === undefined
      ? list === 'next-step' || target === 'next-turn'
      : policy.earliestTurn <= turn && (policy.priority !== 'queue' || target === 'next-turn'))
    if (Object.keys(state.scheduling).length > 0) {
      candidates.sort((a, b) => rank[a.policy?.priority ?? (a.list === 'next-step' ? 'steer' : 'queue')]
        - rank[b.policy?.priority ?? (b.list === 'next-step' ? 'steer' : 'queue')]
        || (state.order[a.message.id] ?? 0) - (state.order[b.message.id] ?? 0))
    }
    let ordinaryClaimed = false
    const selected = candidates.filter(({ list, policy }) => {
      const ordinary = policy === undefined ? list === 'next-turn' : policy.priority === 'queue' && !policy.passive
      if (ordinary && ordinaryClaimed) return false
      ordinaryClaimed ||= ordinary
      return true
    })
    reserve(selected.map(item => item.message))
    const claimed: UserMessage[] = []
    for (const { message, list } of selected) {
      const index = this.current()[list].findIndex(item => item.id === message.id)
      this.mutate(list, index, 1, [], false)
      claimed.push(message)
    }
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  /**
   * Inspect admission without conflating a reservation with dispatch.
   * @param id - input identity.
   * @returns the current admission stage.
   */
  inputState(id: MessageId): 'queued' | 'claimed' | 'injected' | 'missing' {
    const state = this.current()
    if (Object.values(state.claims).some(claim => claim.transition.messageIds.includes(id))) return 'claimed'
    if (state.dispatched.includes(id)) return 'injected'
    return this.locate(id) === undefined ? 'missing' : 'queued'
  }

  /**
   * Record appended claims, retaining their reservation through synchronous request failures.
   * @param turn - owning turn.
   * @param step - owning step.
   * @param userEventSeqs - committed user events.
   */
  appended(turn: number, step: number, userEventSeqs: readonly import('@panedesk/dsh-session').SessionSeq[]): void {
    for (const claim of Object.values(this.current().claims)) {
      if (claim.transition.turn !== turn || claim.transition.step !== step || claim.appended.length === 0) continue
      this.session.append('agent/input/transition', { ...claim.transition, phase: 'appended', userEventSeqs })
    }
  }

  /** Restore reservations with no historical user append, preserving their original order. */
  rollback(): void {
    for (const claim of Object.values(this.current().claims)) {
      if (claim.appended.length > 0) continue
      for (const { message, scheduling, target } of [...claim.entries].reverse()) {
        if (this.locate(message.id) === undefined) this.mutate(target, 0, 0, [message], false, [scheduling])
      }
      this.session.append('agent/input/transition', {
        ...claim.transition, phase: 'rolled-back', scheduling: claim.entries.map(entry => entry.scheduling),
      })
    }
  }

  /**
   * Commit first dispatch for appended input actually present in this request.
   * @param messageIds - immutable request identities.
   */
  dispatchInput(messageIds: readonly MessageId[]): void {
    const requestId = brandString<Extract<InputTransition, { phase: 'dispatched' }>['requestId']>(randomUUID())
    for (const claim of Object.values(this.current().claims)) {
      if (claim.appended.length === 0 || !claim.transition.messageIds.every(id => messageIds.includes(id))) continue
      const transition: Extract<InputTransition, { phase: 'dispatched' }> = { ...claim.transition, phase: 'dispatched', requestId }
      this.session.append('agent/input/transition', transition)
      this.dispatch.emit('agent/input-dispatching', { transition })
    }
  }

  /**
   * Append one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to append.
   */
  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.current()[target].length, 0, [message])
  }

  /**
   * Prepend one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   */
  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  /**
   * Replace one pending message in place.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    if (this.inputState(messageId) === 'claimed') return false
    const location = this.locate(messageId)
    if (location === undefined) return false
    const policy = this.schedulingOf(messageId)
    this.mutate(location.target, location.index, 1, [newMessage], true, policy === undefined ? undefined : [policy])
    return true
  }

  /**
   * Remove one pending message.
   * @param messageId - identity of the pending message to remove.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean {
    if (this.inputState(messageId) === 'claimed') return false
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /**
   * Apply standard splice semantics and durably record the normalized result.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @returns messages removed by the splice.
   */
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    const state = this.current()
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** Read the current durable projection state. */
  private current(): ScheduledInboxState {
    const state = this.projections.stateOf(this.session, 'inbox')
    if (state === undefined) {
      throw new Error(
        `agent "${this.session.id}" cannot read inbox state: its projection registration is not active`,
      )
    }
    return state as ScheduledInboxState
  }

  /** Commit one normalized mutation and publish its live events. */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
    scheduling?: readonly InputScheduling[],
  ): UserMessage[] {
    const state = this.current()
    const inbox = state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted)
    const ids = new Set<string>()
    for (const message of target === 'next-turn'
      ? [...candidate, ...state['next-step']]
      : [...state['next-turn'], ...candidate]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    const splice: SessionEventMap['agent/inbox/spliced'] = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(scheduling === undefined ? {} : { scheduling }),
      ...(outcome === undefined ? {} : { outcome }),
    }
    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount)
    if (scheduling !== undefined) {
      this.session.append('agent/input/transition', { phase: 'scheduled', messageIds: inserted.map(message => message.id), scheduling })
    }
    const event = this.session.append('agent/inbox/spliced', splice)
    if (discardRemoved) {
      for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    }
    for (const message of event.data.inserted) {
      this.dispatch.emit('agent/inbox/inserted', { message })
    }
    return removed
  }
}
