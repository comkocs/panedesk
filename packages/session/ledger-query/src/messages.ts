/** Message CLI adapters use optional delivery and journal services without opening Agents. */
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { Context } from '@panedesk/cordis'
import type { MessageDelivery, MessageControlRequest, OperationId, ControlResult, MessageQuery, MessageReason, MessageState, SendMessageResult, ResolvedRecipient, OperationStatus, SendBatchResult } from '@panedesk/dsh-message-delivery'
import type { MessagesCommand } from './messages-cli.ts'
import { messagesHelp } from './messages-cli.ts'
import type { LedgerMessagesPage, LedgerMessageProjection, MessageLedgerReader, LedgerSessionsPage } from './types.ts'

/** Machine-readable exit status and body; failures never contain submitted message text. */
export interface MessageCommandResult { code: number; output: unknown }
function failure(code: number, reason: string, message: string): MessageCommandResult {
  return { code, output: { error: { code: reason, message } } }
}
/** Current public state, when the runtime attached one to a refusal. */
function stateOf(status: { readonly state: MessageState } | null | undefined): MessageState | undefined {
  return status?.state
}
/** One English sentence for a structured refusal cause and, when known, the current state.
 * @param reason - Structured refusal cause from the delivery service.
 * @param state - Current public state, when the runtime reported one.
 * @returns Sentence naming the cause and the current state.
 */
export function describeReason(reason: MessageReason, state: MessageState | undefined): string {
  const current = state === undefined ? '' : `; current state: ${state}`
  switch (reason) {
    case 'injected': return `already injected, cannot be withdrawn${current}`
    case 'claimed': return `already claimed and about to be injected${current}`
    case 'terminal-state': return `already in a terminal state and cannot be changed${current}`
    case 'revision-conflict': return `revision conflict; the message changed before this command${current}`
    case 'operation-conflict': return `operation conflict; this operation id was already used with different input${current}`
    case 'unauthorized': return `not authorized to control this message${current}`
    case 'invalid-content': return `invalid message content${current}`
    case 'invalid-priority': return `invalid message priority${current}`
    case 'invalid-reply': return `invalid reply; a reply requires an existing message${current}`
    case 'message-not-found': return `message not found${current}`
    case 'target-closed-pending': return `target is closed; stored as pending delivery${current}`
    case 'target-archived': return `target is archived and does not accept messages${current}`
    case 'target-not-found': return `target not found${current}`
    case 'offline': return `target seat is offline${current}`
    case 'busy-not-accepting': return `target seat is busy and does not accept messages${current}`
    case 'target-ambiguous': return `target name is ambiguous; refusing to pick one${current}`
    case 'receive-disabled': return `target does not accept messages${current}`
    case 'handoff-only': return `target accepts handoffs only${current}`
    case 'cross-node-unsupported': return `cross-node delivery is not supported${current}`
    case 'unavailable': return `target is unavailable${current}`
    case 'delivery-uncertain': return `delivery outcome is uncertain${current}`
    case 'unsupported': return `command is not supported${current}`
    case 'interjection': return `interjection was recorded${current}`
    case 'record-corrupt': return `the mailbox record is damaged and the message was rejected${current}`
    default: {
      const unreachable: never = reason
      return unreachable
    }
  }
}
/** English sentence for one control outcome. JSON fields stay unchanged.
 * @param action - Control command that produced the outcome.
 * @param result - Owner decision or pending-owner acknowledgement.
 * @returns Sentence naming the message, the outcome, and the current state.
 */
export function describeControl(action: 'withdraw' | 'edit' | 'reprioritize' | 'invalidate', result: ControlResult): string {
  const id = String(result.messageId)
  if (result.kind === 'applied') {
    const state = result.status.state
    const verb = action === 'withdraw' ? 'withdrawn' : action === 'edit' ? 'edited' : action === 'reprioritize' ? 'reprioritized' : 'invalidated'
    return `Message ${id} was ${verb}; current state: ${state}.`
  }
  if (result.kind === 'accepted-pending-owner') return `Message ${id} was accepted and is waiting for the owner; current state: queued.`
  return `Message ${id} was refused: ${describeReason(result.reason, stateOf(result.status))}.`
}
/** English sentence for one send acknowledgement.
 * @param result - Delivery acknowledgement, distinct from later lifecycle state.
 * @returns Sentence naming the message and the delivery outcome.
 */
export function describeSend(result: SendMessageResult): string {
  const id = String(result.messageId)
  if (result.deliveryOutcome === 'accepted') return `Message ${id} was accepted and queued; current state: queued.`
  return `Message ${id} was refused: ${describeReason(result.reason, result.messageState)}.`
}
/** English sentence for one address resolution, including a dry run.
 * @param item - Exact recipient or a refusal with candidates.
 * @returns Sentence naming the resolved session or the refusal cause.
 */
export function describeResolution(item: ResolvedRecipient): string {
  if (item.kind === 'resolved') {
    const name = item.recipient.window ?? item.recipient.title ?? String(item.recipient.sessionId)
    return `Recipient ${name} resolved to session ${String(item.recipient.sessionId)} (${item.recipient.status}).`
  }
  return `Recipient was refused: ${describeReason(item.reason, undefined)}.`
}
/** English sentences for a batch send or a resolution-only result.
 * @param result - Independent recipient resolutions or send acknowledgements.
 * @returns One sentence per recipient, separated by newlines.
 */
export function describeBatch(result: SendBatchResult): string {
  if (result.kind === 'resolved') return result.recipients.map(describeResolution).join('\n')
  return result.results.map(describeSend).join('\n')
}
/** English sentence for a durable operation observation. The operation record has no command verb.
 * @param result - Missing, pending, or settled operation observation.
 * @returns Sentence naming the operation and its outcome.
 */
export function describeOperation(result: OperationStatus): string {
  const id = String(result.operationId)
  if (result.kind === 'not-found') return `Operation ${id} was not found.`
  if (result.kind === 'applied') return `Operation ${id} was applied to message ${String(result.messageId)}; current state: ${result.status.state}.`
  if (result.kind === 'accepted-pending-owner') return `Operation ${id} was accepted and is waiting for the owner; current state: queued.`
  return `Operation ${id} was refused: ${describeReason(result.reason, stateOf(result.status))}.`
}
/** Write the human-readable sentence. Machine-readable JSON stays on stdout. */
function explain(sentence: string): void {
  process.stderr.write(sentence.endsWith('\n') ? sentence : `${sentence}\n`)
}
function reader(value: object): value is object & MessageLedgerReader {
  return 'queryMessages' in value && typeof value.queryMessages === 'function'
    && 'querySessions' in value && typeof value.querySessions === 'function'
}
function operation(): OperationId { return randomUUID() as OperationId }
function controlResult(action: 'withdraw' | 'edit' | 'reprioritize' | 'invalidate', result: ControlResult): MessageCommandResult {
  explain(describeControl(action, result))
  return { code: result.kind === 'rejected' ? 4 : 0, output: result }
}
function safeData(data: LedgerMessageProjection['data']) {
  return { messageId: data.messageId, senderSessionId: data.senderSessionId, targetSessionId: data.targetSessionId,
    priority: data.priority, messageClass: data.messageClass, state: data.state, revision: data.revision, stateVersion: data.stateVersion,
    operationId: data.operationId, transition: data.transition, observedAt: data.observedAt, reason: data.reason,
    firstRequestId: data.firstRequestId, firstTurnId: data.firstTurnId, deliveryOutcome: data.deliveryOutcome, pending: data.pending }
}
function safeMessage(item: LedgerMessageProjection) {
  return { messageId: item.messageId, nodeId: item.nodeId, state: item.state, phase: item.phase, revision: item.revision,
    stateVersion: item.stateVersion, createdAt: item.createdAt, data: safeData(item.data),
    stateTimes: Object.fromEntries(['queued', 'injected', 'responded', 'withdrawn', 'invalidated', 'rejected']
      .flatMap((key) => {
        const time = item.stateTimes[key as keyof typeof item.stateTimes]
        return time === undefined ? [] : [[key, time]]
      })),
    transitions: item.transitions.map(event => ({ cursor: event.cursor, nodeId: event.nodeId, data: safeData(event.data) })) }
}
/** Serialize a selected status page with deterministic ordering and body-free fields.
 * @param page - Already filtered journal projection and exclusive next cursor.
 * @returns JSONL header and versioned status records, including empty or incomplete pages.
 */
export function serializeMessages(page: LedgerMessagesPage): string {
  const items = [...page.items].sort((a, b) => a.createdAt - b.createdAt
    || compare(a.nodeId, b.nodeId) || compare(a.messageId, b.messageId))
  return [JSON.stringify({ schemaVersion: 1, kind: 'message/export', complete: page.complete, asOf: page.asOf, nextCursor: page.nextCursor }),
    ...items.map(item => JSON.stringify({ schemaVersion: 1, kind: 'message/status', complete: page.complete, item: safeMessage(item) }))].join('\n') + '\n'
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
async function joined(reader: MessageLedgerReader, query: MessageQuery): Promise<{ page: LedgerMessagesPage; joined: LedgerSessionsPage }> {
  const common = { ...query.sessionId === undefined ? {} : { sessionId: query.sessionId },
    ...query.from === undefined ? {} : { from: query.from }, ...query.to === undefined ? {} : { to: query.to } }
  const [page, sessions] = await Promise.all([reader.queryMessages(query), reader.querySessions(common)])
  const selected = new Set(page.items.map(item => `${item.nodeId}:${item.messageId}`))
  const groups = sessions.sessions.filter(group => query.sessionId === undefined || group.sessionId === query.sessionId).map(group => ({
    ...group, messages: group.messages.filter(item => selected.has(`${item.nodeId}:${item.messageId}`)),
  })).filter(group => group.calls.length || group.messages.length)
  return { page, joined: { ...sessions, complete: sessions.complete && page.complete, sessions: groups,
    unassignedMessages: sessions.unassignedMessages.filter(item => selected.has(`${item.nodeId}:${item.messageId}`)) } }
}
async function deliver(delivery: MessageDelivery, command: MessagesCommand): Promise<MessageCommandResult> {
  switch (command.action) {
    case 'send': {
      if (!command.target || !command.classification || command.text === undefined) throw new Error('Invalid parsed send')
      const result = await delivery.send({ ...command.classification, target: command.target, content: command.text,
        operationId: command.operationId ?? operation(), ...command.priority === undefined ? {} : { priority: command.priority } })
      explain(describeSend(result))
      return { code: result.deliveryOutcome === 'rejected' ? 4 : 0, output: result }
    }
    case 'withdraw': case 'edit': case 'reprioritize': case 'invalidate': {
      if (!command.messageId) throw new Error('Invalid parsed control')
      const request: MessageControlRequest = { messageId: command.messageId, operationId: command.operationId ?? operation(),
        expectedRevision: command.expectedRevision ?? (await delivery.status(command.messageId)).revision }
      if (command.action === 'withdraw') return controlResult('withdraw', await delivery.withdraw(request))
      if (command.action === 'edit' && command.text !== undefined) return controlResult('edit', await delivery.edit({ ...request, content: command.text }))
      if (command.action === 'reprioritize' && command.priority) return controlResult('reprioritize', await delivery.reprioritize({ ...request, priority: command.priority }))
      if (command.action === 'invalidate' && command.reason !== undefined) return controlResult('invalidate', await delivery.invalidate({ ...request, reason: command.reason }))
      throw new Error('Invalid parsed control payload')
    }
    case 'status': {
      if (!command.messageId) throw new Error('Invalid parsed status')
      const status = await delivery.status(command.messageId)
      explain(`Message ${String(status.messageId)} is ${status.state}; current state: ${status.state}.`)
      return { code: 0, output: status }
    }
    case 'operation': {
      if (!command.operationId) throw new Error('Invalid parsed operation')
      const result = await delivery.operationStatus(command.operationId)
      explain(describeOperation(result))
      return { code: result.kind === 'not-found' ? 5 : result.kind === 'rejected' ? 4 : 0, output: result }
    }
    case 'resolve': case 'send-batch': {
      if (!command.recipients) throw new Error('Invalid parsed recipients')
      if (command.action === 'resolve' || command.dryRun) {
        const recipients = await delivery.resolve(command.recipients)
        const resolved = { kind: 'resolved' as const, recipients }
        explain(describeBatch(resolved))
        return { code: recipients.some(item => item.kind === 'rejected') ? 4 : 0, output: resolved }
      }
      if (!command.classification || command.text === undefined) throw new Error('Invalid parsed batch')
      const result = await delivery.sendBatch({ ...command.classification, content: command.text, dryRun: false,
        ...command.priority === undefined ? {} : { priority: command.priority },
        recipients: command.recipients.map(target => ({ target, operationId: operation() })) })
      explain(describeBatch(result))
      return { code: result.kind === 'sent' && result.results.some(item => item.deliveryOutcome === 'rejected') ? 4 : 0, output: result }
    }
    case 'watch': {
      if (!command.query.sessionId) throw new Error('Invalid parsed subscription')
      const subscription = delivery.subscribe({ sessionId: command.query.sessionId,
        ...command.query.cursor === undefined ? {} : { cursor: command.query.cursor } })
      let events = 0
      for await (const event of subscription) {
        process.stdout.write(JSON.stringify({ schemaVersion: 1, cursor: event.cursor, nodeId: event.nodeId, data: safeData(event.data) }) + '\n')
        events++
      }
      return { code: 0, output: { events } }
    }
    default: throw new Error('Not a delivery command')
  }
}
/** Execute optional message capabilities, preserving existing non-message ledger behavior.
 * @param ctx - Invocation context; absent session authority remains a human origin in the provider.
 * @param command - Validated message arguments.
 * @returns Usage 2, unavailable 3, refused 4, missing operation 5, incomplete 6, or success 0.
 */
export async function executeMessages(ctx: Context, command: MessagesCommand): Promise<MessageCommandResult> {
  if (command.action === 'help') return { code: 0, output: messagesHelp }
  try {
    if (command.action === 'query' || command.action === 'unanswered' || command.action === 'export') {
      const ledger = ctx.get('sessionLedger')
      if (!ledger || !reader(ledger)) return failure(3, 'messages/query-unavailable', 'Message ledger query and session join services are unavailable')
      if (command.action === 'export') {
        const page = await ledger.queryMessages(command.query)
        const jsonl = serializeMessages(page)
        if (command.outputPath) await writeFile(command.outputPath, jsonl, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        return { code: page.complete ? 0 : 6, output: { format: 'jsonl', complete: page.complete, nextCursor: page.nextCursor,
          rows: page.items.length, ...command.outputPath ? { outputPath: command.outputPath } : { jsonl } } }
      }
      const result = await joined(ledger, command.query)
      return { code: result.joined.complete ? 0 : 6, output: result }
    }
    const delivery = ctx.get('messageDelivery')
    if (!delivery) return failure(3, 'messages/delivery-unavailable', 'MessageDelivery is unavailable; configure a delivery provider')
    if (command.action === 'quarantined') {
      if (!delivery.quarantined) return failure(3, 'messages/query-unavailable', 'Quarantine query is unavailable')
      const page = await delivery.quarantined(command.query)
      return { code: page.complete ? 0 : 6, output: page }
    }
    return await deliver(delivery, command)
  } catch (error) {
    const reason = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
    if (reason === 'message-not-found' || reason === 'messages/message-not-found') {
      const missing = failure(5, 'messages/message-not-found', 'The message does not exist')
      explain('The message does not exist.')
      return missing
    }
    const failed = failure(1, 'messages/operation-failed', 'Message command failed; check service availability, identifiers, and output permissions')
    explain('Message command failed; check service availability, identifiers, and output permissions.')
    return failed
  }
}
