/** Message CLI adapters use optional delivery and journal services without opening Agents. */
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { Context } from '@panedesk/cordis'
import type { MessageDelivery, MessageControlRequest, OperationId, ControlResult, MessageQuery } from '@panedesk/dsh-message-delivery'
import type { MessagesCommand } from './messages-cli.ts'
import { messagesHelp } from './messages-cli.ts'
import type { LedgerMessagesPage, LedgerMessageProjection, MessageLedgerReader, LedgerSessionsPage } from './types.ts'

/** Machine-readable exit status and body; failures never contain submitted message text. */
export interface MessageCommandResult { code: number; output: unknown }
function failure(code: number, reason: string, message: string): MessageCommandResult {
  return { code, output: { error: { code: reason, message } } }
}
function reader(value: object): value is object & MessageLedgerReader {
  return 'queryMessages' in value && typeof value.queryMessages === 'function'
    && 'querySessions' in value && typeof value.querySessions === 'function'
}
function operation(): OperationId { return randomUUID() as OperationId }
function controlResult(result: ControlResult): MessageCommandResult { return { code: result.kind === 'rejected' ? 4 : 0, output: result } }
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
      return { code: result.deliveryOutcome === 'rejected' ? 4 : 0, output: result }
    }
    case 'withdraw': case 'edit': case 'reprioritize': case 'invalidate': {
      if (!command.messageId) throw new Error('Invalid parsed control')
      const request: MessageControlRequest = { messageId: command.messageId, operationId: command.operationId ?? operation(),
        expectedRevision: command.expectedRevision ?? (await delivery.status(command.messageId)).revision }
      if (command.action === 'withdraw') return controlResult(await delivery.withdraw(request))
      if (command.action === 'edit' && command.text !== undefined) return controlResult(await delivery.edit({ ...request, content: command.text }))
      if (command.action === 'reprioritize' && command.priority) return controlResult(await delivery.reprioritize({ ...request, priority: command.priority }))
      if (command.action === 'invalidate' && command.reason !== undefined) return controlResult(await delivery.invalidate({ ...request, reason: command.reason }))
      throw new Error('Invalid parsed control payload')
    }
    case 'status': {
      if (!command.messageId) throw new Error('Invalid parsed status')
      return { code: 0, output: await delivery.status(command.messageId) }
    }
    case 'operation': {
      if (!command.operationId) throw new Error('Invalid parsed operation')
      const result = await delivery.operationStatus(command.operationId)
      return { code: result.kind === 'not-found' ? 5 : result.kind === 'rejected' ? 4 : 0, output: result }
    }
    case 'resolve': case 'send-batch': {
      if (!command.recipients) throw new Error('Invalid parsed recipients')
      if (command.action === 'resolve' || command.dryRun) {
        const recipients = await delivery.resolve(command.recipients)
        return { code: recipients.some(item => item.kind === 'rejected') ? 4 : 0, output: { kind: 'resolved', recipients } }
      }
      if (!command.classification || command.text === undefined) throw new Error('Invalid parsed batch')
      const result = await delivery.sendBatch({ ...command.classification, content: command.text, dryRun: false,
        ...command.priority === undefined ? {} : { priority: command.priority },
        recipients: command.recipients.map(target => ({ target, operationId: operation() })) })
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
    return await deliver(delivery, command)
  } catch (error) {
    const reason = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
    if (reason === 'message-not-found' || reason === 'messages/message-not-found') return failure(5, 'messages/message-not-found', 'The message does not exist')
    return failure(1, 'messages/operation-failed', 'Message command failed; check service availability, identifiers, and output permissions')
  }
}
