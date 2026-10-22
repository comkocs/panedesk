/** Owner-local queue and persistence substitutes for the public scheduling interfaces. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { Session, SessionId } from '@panedesk/dsh-session'
import { createUserMessage, type UserMessage } from '@panedesk/dsh-llm'
import type { Agent, EnqueueOptions } from '@panedesk/dsh-agent'
import type { InputTransition } from '@panedesk/dsh-agent/types'
import type { DeliveryMessage, MessageStateEvent, NodeId, OperationId } from '@panedesk/dsh-message-delivery'
import { FileMailbox } from '../../src/mailbox.ts'
import { MailboxArbitrator } from '../../src/arbitrator.ts'
import type { DeliveryDriver, ControlCommand } from '../../src/types.ts'
import { decodeDecision, decodeControlResult } from '../../src/codec.ts'
import { readValue } from '../../src/files.ts'

/** Create a substitute implementing the scheduling interface.
 * @param ctx - lifecycle host.
 * @param session - Session with an acquired lease.
 * @returns queue, scheduling options, and a registerable agent.
 */
export function schedulerFixture(ctx: Context, session: Session) {
  const queue: UserMessage[] = []
  const options = new Map<string, EnqueueOptions>()
  const agent: Agent = {
    id: session.id, session, ctx, options: {}, status: 'idle',
    inbox: {
      nextStep: queue, nextTurn: [],
      clear() { queue.splice(0) },
      append(_target, message) { queue.push(message) },
      prepend(_target, message) { queue.unshift(message) },
      replace(messageId, message) {
        const index = queue.findIndex(item => item.id === messageId)
        if (index < 0) return false
        queue[index] = message
        return true
      },
      remove(messageId) {
        const index = queue.findIndex(item => item.id === messageId)
        if (index < 0) return false
        queue.splice(index, 1)
        return true
      },
      splice(_target, start, count, inserted) { return queue.splice(start, count, ...inserted) },
    },
    send(message) { queue.push(message) }, followup(message) { queue.push(message) },
    steer(message) { queue.push(message) }, inject(message) { queue.push(message) },
    cancel() {}, whenIdle() { return Promise.resolve() },
    runMaintenance(task) { return task(new AbortController().signal) },
  }
  const driver: DeliveryDriver = {
    agent, get hasRunnable() { return queue.some(item => !options.get(item.id)?.passive) },
    enqueue(message, settings) { queue.push(message); options.set(message.id, settings) },
    mutate(messageId, action) {
      if (action.kind === 'remove') return agent.inbox.remove(messageId)
      if (action.kind === 'edit') return agent.inbox.replace(messageId, action.message)
      const index = queue.findIndex(item => item.id === messageId)
      const previous = options.get(messageId)
      if (index < 0 || !previous) return false
      const [message] = queue.splice(index, 1)
      if (!message) return false
      queue.push(message)
      options.set(messageId, { ...previous, priority: action.priority })
      return true
    },
  }
  const scheduled = Object.assign(agent, {
    enqueue: (message: UserMessage, settings: EnqueueOptions) => { driver.enqueue(message, settings) },
    get hasRunnable() { return driver.hasRunnable },
  })
  Object.assign(agent.inbox, { reprioritize: (id: UserMessage['id'], priority: EnqueueOptions['priority']) => driver.mutate(id, { kind: 'reprioritize', priority }) })
  return { agent: scheduled, driver, queue, options }
}

/** Create an isolated arbitrator fixture and file mailbox.
 * @param replay - persisted scheduling facts for recovery.
 * @returns resources with explicit cleanup.
 */
export async function ownerFixture(replay: readonly InputTransition[] = []) {
  const home = await mkdtemp(join(tmpdir(), 'delivery-owner-'))
  const ctx = new Context()
  const id = SessionId('seat-a')
  const { driver, queue, options } = schedulerFixture(ctx, Session.create(id))
  const mailbox = new FileMailbox({ home, nodeId: 'node-a', maxRecordBytes: 1048576, lockTimeoutMs: 5000, lockRetryMs: 1 })
  await mailbox.initialize()
  const receipts: MessageStateEvent[] = []
  let owned = true
  const create = (history: readonly InputTransition[] = replay) => new MailboxArbitrator(mailbox, driver,
    async () => { if (!owned) throw new Error('owner generation changed') },
    async (event) => { if (!receipts.some(item => item.cursor === event.cursor)) receipts.push(event) }, () => true, history)
  let arbitrator = create()
  const message: DeliveryMessage = {
    messageId: createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }).id,
    sender: { kind: 'human', sessionId: null }, senderSessionId: null,
    target: { nodeId: 'node-a' as NodeId, sessionId: id }, messageClass: 'handoff', priority: 'steer',
    content: 'hello', createdAt: Date.now(), revision: 0, operationId: 'send-a' as OperationId,
    mailboxSequence: 0, stateVersion: 0,
  }
  const root = await mailbox.target(id)
  return {
    home, ctx, id, queue, options, mailbox, receipts, message,
    get arbitrator() { return arbitrator },
    fence() { owned = false },
    async restart(history: readonly InputTransition[] = []) {
      await arbitrator.close()
      queue.splice(0)
      arbitrator = create(history)
      await arbitrator.drain()
    },
    async send() {
      await mailbox.append(id, message.operationId, 'send-digest', { kind: 'send', message, result: {
        messageId: message.messageId, operationId: message.operationId, deliveryOutcome: 'accepted', messageState: 'queued', pending: false,
        recipient: { nodeId: message.target.nodeId, sessionId: id, window: null, title: null, status: 'idle', matchedFields: ['sessionId'], observedAt: Date.now() },
      } })
    },
    async control(command: Omit<ControlCommand, 'messageId' | 'sender'> & Partial<Pick<ControlCommand, 'sender'>>, extra: object = {}) {
      const value = { ...command, messageId: message.messageId, sender: command.sender ?? message.sender, ...extra }
      await mailbox.append(id, command.operationId, JSON.stringify(value), value)
    },
    async status() { return decodeDecision(await readValue(join(root, 'decisions', `${message.messageId}.json`), 1048576)) },
    async result(operationId: string) { return decodeControlResult(await readValue(join(root, 'receipts', `operation-${operationId}.json`), 1048576)) },
    async removeReceipt(operationId: string) { await rm(join(root, 'receipts', `operation-${operationId}.json`)) },
    async dispose() {
      try { await arbitrator.close() } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
    },
  }
}
