/** One lease-backed owner arbitrates controls; senders only append mailbox commands. */
import { join } from 'node:path'
import { createUserMessage, freezeMessage, type MessageId, type UserMessage } from '@panedesk/dsh-llm'
import type {
  ControlResult, DeliveryMessage, MessageCursor, MessageReason, MessageStateData,
  MessageStateEvent, MessageStatus, OperationId,
} from '@panedesk/dsh-message-delivery'
import type { InputTransition } from '@panedesk/dsh-agent/types'
import type { FileMailbox } from './mailbox.ts'
import type { ControlCommand, Decision, DeliveryDriver } from './types.ts'
import { decodeCommand, decodeDecision } from './codec.ts'
import { component, MailboxUnavailableError, publish, publishedFiles, readValue } from './files.ts'

/** Identified input reconstructed from the persisted business message.
 * @param message - original sender identity and current revision.
 * @param relatedMessageId - original invalidated message for a notification.
 * @returns immutable input with the same MessageId.
 */
export function inputOf(message: DeliveryMessage, relatedMessageId?: MessageId): UserMessage {
  return freezeMessage({
    id: message.messageId, role: 'user', content: [{ type: 'text', text: message.content }],
    source: {
      kind: 'message-delivery', senderSessionId: message.senderSessionId, operationId: message.operationId,
      ...(relatedMessageId === undefined ? {} : { relatedMessageId }),
      ...(message.messageClass === 'reply' ? { messageClass: 'reply', replyTo: message.replyTo } : { messageClass: message.messageClass }),
    },
  })
}

/** Owner-local arbitration and receipt outbox; Session input transitions are the dispatch authority. */
export class MailboxArbitrator {
  private readonly decisions = new Map<MessageId, Decision>()
  private readonly queued = new Set<MessageId>()
  private readonly requestTurns = new Map<number, Set<MessageId>>()
  private readonly assistantTurns = new Set<number>()
  private chain: Promise<void> = Promise.resolve()
  private initialized = false
  private closing = false
  private failure: unknown
  private readonly pendingTransitions: { messageId: MessageId; data: InputTransition }[] = []

  constructor(
    private readonly mailbox: FileMailbox,
    readonly driver: DeliveryDriver,
    private readonly assertOwner: () => Promise<void>,
    private readonly receipt: (event: MessageStateEvent) => Promise<void>,
    private readonly wakeAllowed: () => boolean,
    private readonly replay: readonly InputTransition[] = [],
    private readonly admission: (message: DeliveryMessage) => MessageReason | undefined = () => undefined,
  ) {}

  /** Process the published high-water cut before the driver's next claim.
   * @returns completion of ordered controls and admission of remaining queued messages.
   */
  drain(): Promise<void> {
    const work = this.chain.then(async () => {
      if (this.failure !== undefined) throw new MailboxUnavailableError('Owner arbitration failed', { cause: this.failure })
      if (this.closing) return
      await this.assertOwner()
      const root = await this.mailbox.target(this.driver.agent.id)
      if (!this.initialized) {
        for (const name of await publishedFiles(join(root, 'decisions'))) {
          const decision = decodeDecision(await readValue(join(root, 'decisions', name), this.mailbox.options.maxRecordBytes))
          this.decisions.set(decision.message.messageId, decision)
        }
        this.initialized = true
        const latest = new Map<MessageId, InputTransition>()
        for (const transition of this.replay) {
          if (transition.phase === 'scheduled') continue
          for (const id of transition.messageIds) {
            latest.set(id, transition)
            if (transition.phase === 'appended' || transition.phase === 'dispatched') this.queued.add(id)
          }
        }
        for (const [id, transition] of latest) {
          const decision = this.decisions.get(id)
          if (!decision || decision.status.phase === 'settled') continue
          const phase = transition.phase === 'rolled-back' ? 'pending' : transition.phase
          if (decision.status.phase !== phase || (phase === 'dispatched' && decision.status.state === 'queued')) {
            this.observe({ ...transition, messageIds: [id] })
          }
        }
      }
      await this.flushTransitions()
      const snapshot = await this.mailbox.snapshot(this.driver.agent.id)
      for (const record of snapshot.records) {
        await this.assertOwner()
        const command = decodeCommand(record.value)
        if (command.kind === 'send') {
          if (!this.decisions.has(command.message.messageId)) {
            const message = { ...command.message, mailboxSequence: record.sequence }
            const reason = this.admission(message)
            const state = reason ? 'rejected' : 'queued'
            const event = this.event(message, reason ? 'rejected' : 'accepted', state, 1, message.operationId,
              reason ? { reason, deliveryOutcome: 'rejected', pending: false } : {})
            await this.commit({ message, status: {
              messageId: message.messageId, state, phase: reason ? 'settled' : 'pending', revision: 0,
              stateVersion: 1, transitions: [event],
            }, events: [event], results: [] })
          }
        } else {
          const path = join(root, 'receipts', `operation-${component(command.operationId)}.json`)
          if (await readValue(path, this.mailbox.options.maxRecordBytes) !== undefined) continue
          await this.applyControl(command, path)
        }
      }
      await this.flushTransitions()
      // Only after the entire cut is decided may an offline send enter the driver.
      for (const decision of this.decisions.values()) {
        for (const event of decision.events) await this.receipt(event)
        if (decision.notification) this.enqueue(decision.notification, false, decision.message.messageId)
        if (decision.status.state === 'queued' && decision.status.phase === 'pending') {
          this.enqueue(decision.message, this.wakeAllowed())
        }
      }
    })
    this.chain = work.catch((error: unknown) => { this.failure = error })
    return work
  }

  private enqueue(message: DeliveryMessage, wakeup: boolean, relatedMessageId?: MessageId): void {
    if (this.queued.has(message.messageId)) return
    const inbox = this.driver.agent.inbox
    if (![...inbox.nextStep, ...inbox.nextTurn].some(input => input.id === message.messageId)) {
      this.driver.enqueue(inputOf(message, relatedMessageId), {
        priority: message.priority, passive: message.messageClass === 'notice' || !wakeup,
        wakeup: message.messageClass !== 'notice' && wakeup,
      })
    }
    this.queued.add(message.messageId)
  }

  private async applyControl(command: ControlCommand, path: string): Promise<void> {
    await this.flushTransitions()
    let decision = this.decisions.get(command.messageId)
    const retained = decision?.results.find(result => result.operationId === command.operationId)
    if (retained) {
      await publish(path, retained, this.mailbox.options.maxRecordBytes)
      return
    }
    let reason: MessageReason | undefined
    if (!decision) reason = 'message-not-found'
    else if (decision.message.senderSessionId !== command.sender.sessionId || decision.message.sender.kind !== command.sender.kind) reason = 'unauthorized'
    else if (decision.status.revision !== command.expectedRevision) reason = 'revision-conflict'
    else if (decision.status.phase === 'claimed' || decision.status.phase === 'appended') reason = 'claimed'
    else if (decision.status.phase === 'delivery-uncertain') reason = 'delivery-uncertain'
    else if (['withdrawn', 'invalidated', 'rejected'].includes(decision.status.state)) reason = 'terminal-state'
    else if (decision.status.state !== 'queued' && command.kind !== 'invalidate') reason = 'injected'
    else if (command.kind === 'reprioritize' && decision.message.messageClass === 'notice' && command.priority !== 'queue') reason = 'invalid-priority'
    if (reason || !decision) {
      const result: ControlResult = { kind: 'rejected', operationId: command.operationId, messageId: command.messageId, reason: reason ?? 'message-not-found', status: decision?.status ?? null }
      await publish(path, result, this.mailbox.options.maxRecordBytes)
      return
    }
    const invalidating = command.kind === 'invalidate' && decision.status.state !== 'queued'
    const withdrawing = command.kind === 'withdraw' || (command.kind === 'invalidate' && !invalidating)
    let message = decision.message
    let notification: DeliveryMessage | undefined
    if (command.kind === 'edit') message = { ...message, content: command.content, revision: message.revision + 1 }
    if (command.kind === 'reprioritize') message = { ...message, priority: command.priority, revision: message.revision + 1 }
    // Synchronous queue mutation and phase inspection precede persistence: a passed preparation
    // barrier cannot claim an item while a withdrawal is awaiting its fsync.
    if (this.queued.has(message.messageId) && decision.status.state === 'queued') {
      const changed = this.driver.mutate(message.messageId,
        withdrawing ? { kind: 'remove' } : command.kind === 'edit'
          ? { kind: 'edit', message: inputOf(message) }
          : { kind: 'reprioritize', priority: message.priority })
      if (!changed) {
        const result: ControlResult = { kind: 'rejected', operationId: command.operationId, messageId: command.messageId, reason: 'claimed', status: decision.status }
        await publish(path, result, this.mailbox.options.maxRecordBytes)
        return
      }
    }
    if (invalidating) {
      const input = createUserMessage({ content: [{ type: 'text', text: `Message ${message.messageId} was invalidated: ${command.reason}` }], source: {
        kind: 'message-delivery', messageClass: 'handoff', senderSessionId: message.senderSessionId,
        operationId: command.operationId, relatedMessageId: message.messageId,
      } })
      notification = { sender: message.sender, senderSessionId: message.senderSessionId,
        target: message.target, mailboxSequence: message.mailboxSequence, messageClass: 'handoff', messageId: input.id,
        operationId: command.operationId, content: `Message ${message.messageId} was invalidated: ${command.reason}`,
        priority: 'steer', createdAt: Date.now(), revision: 0, stateVersion: 0 }
    }
    const state = withdrawing ? 'withdrawn' : invalidating ? 'invalidated' : decision.status.state
    const transition = withdrawing ? 'withdrawn' : invalidating ? 'invalidated' : command.kind === 'edit' ? 'edited' : 'reprioritized'
    const version = decision.status.stateVersion + 1
    const event = this.event(message, transition, state, version, command.operationId)
    const status: MessageStatus = { ...decision.status, state, phase: withdrawing || invalidating ? 'settled' : decision.status.phase,
      revision: message.revision, stateVersion: version, transitions: [...decision.status.transitions, event] }
    const result: ControlResult = { kind: 'applied', operationId: command.operationId, messageId: command.messageId, status }
    decision = { ...decision, message, status, events: [...decision.events, event],
      results: [...decision.results, result], ...(notification ? { notification } : {}) }
    await this.commit(decision)
    await publish(path, result, this.mailbox.options.maxRecordBytes)
  }

  /** Observe the synchronous persisted phase before any later control may settle.
   * @param transition - driver's durable input fact.
   */
  observe(transition: InputTransition): void {
    if (transition.phase === 'scheduled') return
    for (const messageId of transition.messageIds) {
      const decision = this.decisions.get(messageId)
      if (!decision) continue
      const phase = transition.phase === 'rolled-back' ? 'pending' : transition.phase
      this.decisions.set(messageId, { ...decision, status: { ...decision.status, phase } })
      this.pendingTransitions.push({ messageId, data: transition })
      if (transition.phase === 'dispatched') {
        const ids = this.requestTurns.get(transition.turn) ?? new Set<MessageId>()
        ids.add(messageId)
        this.requestTurns.set(transition.turn, ids)
      }
    }
  }

  /** Associate retained dispatched history with a later real request.
   * @param turn - actual request's turn.
   * @param messageIds - identities present in the assembled provider request.
   */
  request(turn: number, messageIds: readonly MessageId[]): void {
    const ids = this.requestTurns.get(turn) ?? new Set<MessageId>()
    for (const id of messageIds) {
      const decision = this.decisions.get(id)
      if (decision && (decision.status.state === 'injected' || decision.status.phase === 'dispatched')) ids.add(id)
    }
    this.requestTurns.set(turn, ids)
  }

  /** Record only durable assistant replies, never model-authored receipt text.
   * @param turn - reply's actual turn.
   */
  assistant(turn: number): void { this.assistantTurns.add(turn) }

  /** Settle the first successful containing turn, preserving the original injection time.
   * @param turn - settled turn.
   * @param successful - normal, non-interrupted completion.
   * @returns durable response receipts.
   */
  finish(turn: number, successful: boolean): Promise<void> {
    const work = this.chain.then(async () => {
      await this.flushTransitions()
      if (successful && this.assistantTurns.has(turn)) {
        for (const id of this.requestTurns.get(turn) ?? []) {
          const decision = this.decisions.get(id)
          if (!decision || decision.status.state !== 'injected') continue
          const version = decision.status.stateVersion + 1
          const event = this.event(decision.message, 'responded', 'responded', version, decision.message.operationId)
          await this.commit({ ...decision, events: [...decision.events, event], status: {
            ...decision.status, state: 'responded', phase: 'settled', stateVersion: version,
            transitions: [...decision.status.transitions, event],
          } })
        }
      }
      this.assistantTurns.delete(turn)
      this.requestTurns.delete(turn)
    })
    this.chain = work.catch((error: unknown) => { this.failure = error })
    return work
  }

  private async flushTransitions(): Promise<void> {
    while (this.pendingTransitions.length > 0) {
      const pending = this.pendingTransitions.shift()
      if (!pending) break
      const decision = this.decisions.get(pending.messageId)
      if (!decision || pending.data.phase === 'scheduled') continue
      if (pending.data.phase === 'dispatched' && decision.status.transitions.some(event => event.data.transition === 'injected')) continue
      const version = decision.status.stateVersion + 1
      const transition = pending.data.phase === 'dispatched' ? 'injected' : pending.data.phase
      const state = pending.data.phase === 'dispatched' ? 'injected' : decision.status.state
      const phase = pending.data.phase === 'rolled-back' ? 'pending' : pending.data.phase
      const event = this.event(decision.message, transition, state, version, decision.message.operationId,
        pending.data.phase === 'dispatched' ? { firstRequestId: pending.data.requestId, firstTurnId: pending.data.turn } : {})
      await this.commit({ ...decision, events: [...decision.events, event], status: {
        ...decision.status, state, phase,
        stateVersion: version, transitions: [...decision.status.transitions, event],
      } })
    }
  }

  private event(message: DeliveryMessage, transition: MessageStateData['transition'], state: MessageStateData['state'], version: number,
    operationId: OperationId, extra: Partial<MessageStateData> = {}): MessageStateEvent {
    return { nodeId: message.target.nodeId,
      cursor: `${message.target.sessionId}:${message.messageId}:${String(version).padStart(16, '0')}` as MessageCursor,
      data: { messageId: message.messageId, senderSessionId: message.senderSessionId, targetSessionId: message.target.sessionId,
        priority: message.priority, messageClass: message.messageClass, state, revision: message.revision,
        stateVersion: version, operationId, transition, observedAt: Date.now(), ...extra } }
  }

  private async commit(decision: Decision): Promise<void> {
    await this.assertOwner()
    const root = await this.mailbox.target(this.driver.agent.id)
    await publish(join(root, 'decisions', `${component(decision.message.messageId)}.json`), decision, this.mailbox.options.maxRecordBytes)
    // Preserve a synchronous claim/dispatch that happened while the disk write was pending.
    const current = this.decisions.get(decision.message.messageId)
    this.decisions.set(decision.message.messageId,
      current && this.pendingTransitions.some(item => item.messageId === decision.message.messageId)
        ? { ...decision, status: { ...decision.status, phase: current.status.phase } } : decision)
    for (const event of decision.events) await this.receipt(event)
  }

  /** Stop new admission and await all owner writes before releasing its lease. */
  async close(): Promise<void> {
    this.closing = true
    await this.chain
    await this.flushTransitions()
    if (this.failure !== undefined) throw new MailboxUnavailableError('Owner arbitration failed', { cause: this.failure })
  }
}
