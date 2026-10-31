/**
 * Shared wire protocol for the DeepSeek Harness SDK runtime: the
 * newline-delimited JSON-RPC stdio transport plus the named request, result,
 * and notification types both wire ends speak. The runtime server plugin
 * (`@panedesk/dsh-sdk-jsonrpc-server`) serves this protocol; SDK clients
 * (`@panedesk/dsh-sdk-client`, the Python SDK) drive it.
 *
 * @module @panedesk/dsh-sdk-protocol
 */

import type { MessagesRequestMap, HarnessSdkNotificationMap } from './types.ts'
import { decodeSeatFailureCause } from './seat.ts'

export { JsonRpcLineTransport, JsonRpcResponseError } from './transport.ts'
export { decodeSeatRequest, decodeSeatResult, isSeatMethod, decodeSeatFailureCause,
  decodeNodeWorkChainRequest, decodeNodeWorkChainResult, encodeNodeWorkChainFrame,
  decodeNodeDelegationEvidenceRequest, decodeNodeDelegationEvidenceResult } from './seat.ts'
export type { SeatRequestMap } from './types.ts'
export type * from '@panedesk/dsh-seat'

/** Version of the optional same-node message extension. */
export const MESSAGES_VERSION = 1

type Validator = (value: unknown) => boolean
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text: Validator = value => typeof value === 'string' && value.length > 0
const number: Validator = value => typeof value === 'number' && Number.isFinite(value)
const integer: Validator = value => number(value) && Number.isSafeInteger(value) && Number(value) >= 0
const boolean: Validator = value => typeof value === 'boolean'
const oneOf = (...values: readonly unknown[]): Validator => value => values.includes(value)
const optional = (check: Validator): Validator => value => value === undefined || check(value)
const nullable = (check: Validator): Validator => value => value === null || check(value)
const array = (check: Validator): Validator => value => Array.isArray(value) && value.every(check)
const fields = (checks: Record<string, Validator>): Validator => value => record(value)
  && Object.entries(checks).every(([key, check]) => check(value[key]))
const priority = oneOf('immediate', 'steer', 'queue')
const state = oneOf('queued', 'injected', 'responded', 'withdrawn', 'invalidated', 'rejected')
const messageClass = oneOf('handoff', 'notice', 'reply')
const reason = oneOf('target-closed-pending', 'target-archived', 'target-not-found', 'target-ambiguous',
  'receive-disabled', 'handoff-only', 'cross-node-unsupported', 'claimed', 'injected', 'revision-conflict',
  'operation-conflict', 'unauthorized', 'invalid-content', 'invalid-priority', 'invalid-reply',
  'message-not-found', 'terminal-state', 'unavailable', 'delivery-uncertain', 'unsupported', 'interjection', 'record-corrupt',
  'offline', 'busy-not-accepting')
const address: Validator = value => fields({ nodeId: optional(text) })(value) && record(value)
  && ((text(value.sessionId) && value.name === undefined) || (text(value.name) && value.sessionId === undefined))
const classification: Validator = value => record(value) && (value.messageClass === 'reply'
  ? text(value.replyTo) : oneOf('handoff', 'notice')(value.messageClass) && value.replyTo === undefined)
const recipient = fields({ nodeId: text, sessionId: text, window: nullable(text), title: nullable(text),
  status: oneOf('busy', 'idle', 'closed'), matchedFields: array(oneOf('sessionId', 'window', 'title')), observedAt: number })
const resolved: Validator = value => record(value) && address(value.address) && (value.kind === 'resolved'
  ? recipient(value.recipient) : value.kind === 'rejected' && reason(value.reason) && array(recipient)(value.candidates))
const settings = fields({ receiveMode: oneOf('all', 'handoff-only', 'none'), wakeOnHandoff: boolean })
const event = fields({ cursor: text, nodeId: text, data: fields({ messageId: text, senderSessionId: nullable(text),
  targetSessionId: nullable(text), priority, messageClass, state, revision: integer, stateVersion: integer,
  operationId: text, transition: oneOf('accepted', 'rejected', 'claimed', 'appended', 'rolled-back', 'injected',
    'responded', 'withdrawn', 'edited', 'reprioritized', 'invalidated', 'delivery-uncertain'), observedAt: number,
  reason: optional(reason), firstRequestId: optional(text), firstTurnId: optional(integer),
  deliveryOutcome: optional(oneOf('accepted', 'rejected')), pending: optional(boolean) }) })
const status = fields({ messageId: text, state, phase: oneOf('pending', 'claimed', 'appended', 'dispatched', 'settled', 'delivery-uncertain'),
  revision: integer, stateVersion: integer, transitions: array(event) })
const control: Validator = value => fields({ operationId: text, messageId: text })(value) && record(value)
  && (value.kind === 'applied' ? status(value.status)
    : value.kind === 'accepted-pending-owner' ? value.state === 'queued' && integer(value.revision)
      : value.kind === 'rejected' && reason(value.reason) && nullable(status)(value.status))
const routingCause: Validator = (value) => {
  try { decodeSeatFailureCause(value); return true } catch (error) { void error; return false }
}
const sent: Validator = value => fields({ messageId: text, operationId: text, pending: boolean, cause: optional(routingCause) })(value)
  && record(value)
  && (value.deliveryOutcome === 'accepted' ? value.messageState === 'queued' && recipient(value.recipient)
    : value.deliveryOutcome === 'rejected' && reason(value.reason) && (value.reason === 'target-closed-pending'
      ? value.messageState === 'queued' && value.pending === true && recipient(value.recipient)
      : value.messageState === 'rejected' && value.pending === false && array(recipient)(value.candidates)))
const controlFields = { messageId: text, operationId: text, expectedRevision: integer }
const sendFields = { content: text, priority: optional(priority) }
const requestChecks: Record<keyof MessagesRequestMap, Validator> = {
  'messages/send': value => classification(value) && fields({ ...sendFields, target: address, operationId: text })(value),
  'messages/withdraw': fields(controlFields),
  'messages/edit': fields({ ...controlFields, content: text }),
  'messages/reprioritize': fields({ ...controlFields, priority }),
  'messages/invalidate': fields({ ...controlFields, reason: text }),
  'messages/status': fields({ messageId: text }),
  'messages/operationStatus': fields({ operationId: text }),
  'messages/list': fields({ sessionId: optional(text), senderSessionId: optional(text), targetSessionId: optional(text),
    nodeId: optional(text), from: optional(number), to: optional(number), states: optional(array(state)),
    messageClasses: optional(array(messageClass)), unansweredOlderThanMinutes: optional(value => number(value) && Number(value) >= 0),
    includeTerminal: optional(boolean), cursor: optional(text), limit: optional(value => integer(value) && Number(value) > 0) }),
  'messages/resolve': fields({ addresses: array(address) }),
  'messages/sendBatch': value => classification(value) && fields({ ...sendFields,
    recipients: array(fields({ target: address, operationId: text })), dryRun: boolean })(value),
  'messages/configure': fields({ sessionId: text, settings }),
  'messages/subscribe': fields({ sessionId: text, cursor: optional(text) }),
}
const resultChecks: Record<keyof MessagesRequestMap, Validator> = {
  'messages/send': sent,
  'messages/withdraw': control,
  'messages/edit': control,
  'messages/reprioritize': control,
  'messages/invalidate': control,
  'messages/status': status,
  'messages/operationStatus': value => control(value) || fields({ kind: oneOf('not-found'), operationId: text })(value),
  'messages/list': fields({ items: array(status), complete: boolean, nextCursor: optional(text) }),
  'messages/resolve': array(resolved),
  'messages/sendBatch': value => record(value) && (value.kind === 'resolved' ? array(resolved)(value.recipients)
    : value.kind === 'sent' && array(sent)(value.results)),
  'messages/configure': settings,
  'messages/subscribe': fields({ cursor: optional(text) }),
}

/** Identify only frozen message request names, not arbitrary object properties.
 * @param method - incoming method name.
 * @returns whether the name belongs to the message extension.
 */
export function isMessagesMethod(method: string): method is keyof MessagesRequestMap {
  return Object.hasOwn(requestChecks, method)
}

/** Validate a message request before invoking a provider; unknown sender fields are rejected.
 * @param method - frozen request name.
 * @param value - untrusted wire parameters.
 * @returns validated parameters, without trusting wire sender attribution.
 */
export function decodeMessagesRequest<M extends keyof MessagesRequestMap>(method: M, value: unknown): MessagesRequestMap[M]['params'] {
  const impersonates = record(value) && (Object.hasOwn(value, 'sender')
    || (method !== 'messages/list' && Object.hasOwn(value, 'senderSessionId')))
  if (!requestChecks[method](value) || impersonates) {
    throw new TypeError(`Invalid ${method} parameters`)
  }
  return value as MessagesRequestMap[M]['params']
}

/** Validate all consumed message result variants at the process boundary.
 * @param method - request producing the result.
 * @param value - untrusted wire result.
 * @returns the decoded result or a validation error.
 */
export function decodeMessagesResult<M extends keyof MessagesRequestMap>(method: M, value: unknown): MessagesRequestMap[M]['result'] {
  if (!resultChecks[method](value)) throw new TypeError(`Invalid ${method} result`)
  return value as MessagesRequestMap[M]['result']
}

/** Validate durable receipt notifications, including their resume cursor.
 * @param value - untrusted notification parameters.
 * @returns a runtime receipt or a validation error.
 */
export function decodeMessageState(value: unknown): HarnessSdkNotificationMap['messages.state'] {
  if (!event(value)) throw new TypeError('Invalid messages.state notification')
  return value as HarnessSdkNotificationMap['messages.state']
}
export type { JsonRpcTransportPeer } from './transport.ts'
export type { InitializeExecutionPolicy, InitializeLedgerContext, MessagesRequestMap, MessagesSubscribeResult } from './types.ts'
export type * from '@panedesk/dsh-message-delivery'
export type {
  HarnessSdkNotificationMap,
  HarnessSdkRequestMap,
  InitializeParams,
  InitializeResult,
  SdkEncodedImageBlock,
  SdkPromptContentBlock,
  SdkRunStatus,
  SessionEventNotification,
  SessionStatusNotification,
  SessionPromptParams,
  SessionPromptResult,
  SessionResumeParams,
  SessionWaitParams,
  SessionWorkingDirectoryParams,
  SessionWorkingDirectorySetParams,
  SessionWorkingDirectoryResult,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from './types.ts'
