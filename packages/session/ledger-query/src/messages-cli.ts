/** Strict parsing for human-operated message commands. */
import type { MessageAddress, MessageClassification, MessageControlRequest, MessagePriority, MessageQuery, OperationId } from '@panedesk/dsh-message-delivery'

/** Validated message command; identities remain opaque strings after CLI validation. */
export interface MessagesCommand {
  command: 'messages'
  action: 'send' | 'withdraw' | 'edit' | 'reprioritize' | 'invalidate' | 'status' | 'operation' | 'query' | 'unanswered' | 'export' | 'resolve' | 'send-batch' | 'watch' | 'help'
  query: MessageQuery
  target?: MessageAddress
  recipients?: readonly MessageAddress[]
  classification?: MessageClassification
  text?: string
  priority?: MessagePriority
  messageId?: MessageControlRequest['messageId']
  operationId?: OperationId
  expectedRevision?: number
  reason?: string
  dryRun: boolean
  outputPath?: string
}

/** Structured argument failure; command execution maps this to usage exit status 2. */
export class MessageArgumentError extends Error {
  readonly code = 'messages/invalid-arguments'
}
function invalid(message: string): never { throw new MessageArgumentError(message) }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function identity(value: string): string {
  if (!value.trim() || /[\u0000-\u001f\u007f*?]/.test(value) || /\s/u.test(value)) invalid('Expected an explicit identifier without whitespace or wildcards')
  return value
}
function addresses(text: string): MessageAddress[] {
  let value: unknown
  try { value = JSON.parse(text) } catch (error) { throw new MessageArgumentError(error instanceof SyntaxError ? 'Recipients must be a JSON address array' : 'Unable to parse recipients') }
  if (!Array.isArray(value) || value.length === 0) invalid('Recipients must be a nonempty explicit address array')
  return value.map((item: unknown) => {
    if (!object(item) || Object.keys(item).some(key => !['nodeId', 'sessionId', 'name'].includes(key))
      || (typeof item.sessionId === 'string') === (typeof item.name === 'string')
      || item.sessionId !== undefined && typeof item.sessionId !== 'string'
      || item.name !== undefined && typeof item.name !== 'string'
      || item.nodeId !== undefined && typeof item.nodeId !== 'string') invalid('Each recipient requires exactly one sessionId or name')
    const node = item.nodeId === undefined ? {} : { nodeId: identity(item.nodeId) as NonNullable<MessageAddress['nodeId']> }
    if (typeof item.sessionId === 'string') return { ...node, sessionId: identity(item.sessionId) as NonNullable<MessageAddress['sessionId']> }
    if (typeof item.name !== 'string' || !item.name.trim() || /[*?\u0000-\u001f\u007f]/.test(item.name)) invalid('Recipient names must be explicit nonempty names')
    return { ...node, name: item.name.trim() }
  })
}
function number(text: string, integer: boolean): number {
  if (!/^\d+(?:\.\d+)?$/.test(text)) invalid('Expected a nonnegative number')
  const value = Number(text)
  if (!Number.isFinite(value) || integer && !Number.isSafeInteger(value)) invalid('Invalid numeric option')
  return value
}
function time(text: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(text)) invalid('Message times require an explicit timezone')
  const value = Date.parse(text)
  if (!Number.isFinite(value)) invalid('Invalid message time')
  return value
}
/** Parse message arguments without resolving recipients or writing any message.
 * @param args - Inner arguments beginning with messages.
 * @returns Strict command with explicit class and effective send priority.
 */
export function parseMessagesArgs(args: readonly string[]): MessagesCommand {
  const action = args[1]
  if (action === '--help' || action === '-h') {
    if (args.length !== 2) invalid('Help does not accept options')
    return { command: 'messages', action: 'help', query: {}, dryRun: false }
  }
  const filters = ['--session', '--sender-session', '--target-session', '--node', '--from', '--to', '--state', '--class', '--cursor', '--limit']
  const send = ['--class', '--text', '--priority', '--reply-to']
  const control = ['--message-id', '--operation-id', '--expected-revision']
  const allowed = {
    send: [...send, '--to-session', '--to-name', '--node', '--operation-id'],
    withdraw: control, edit: [...control, '--text'], reprioritize: [...control, '--priority'], invalidate: [...control, '--reason'],
    status: ['--message-id'], operation: ['--operation-id'], query: [...filters, '--include-terminal'],
    unanswered: [...filters, '--older-than-minutes', '--include-terminal'], export: [...filters, '--include-terminal', '--format', '--output'],
    resolve: ['--recipients'], 'send-batch': [...send, '--recipients', '--dry-run'], watch: ['--session', '--cursor'],
  }
  if (!action || !Object.hasOwn(allowed, action)) invalid('Unknown messages command; use messages --help')
  const kind = action as keyof typeof allowed
  const flags = new Map<string, string>()
  const booleans = new Set(['--dry-run', '--include-terminal'])
  for (let i = 2; i < args.length; i++) {
    const flag = args[i] ?? ''
    if (!allowed[kind].includes(flag)) invalid(`Unknown or inapplicable message option: ${flag}`)
    if (flags.has(flag)) invalid(`Duplicate message option: ${flag}`)
    const value = booleans.has(flag) ? 'true' : args[++i]
    if (value === undefined || value === '' || value.startsWith('--')) invalid(`Missing value: ${flag}`)
    flags.set(flag, value)
  }
  const require = (flag: string) => flags.get(flag) ?? invalid(`Required option: ${flag}`)
  const query: { -readonly [K in keyof MessageQuery]: MessageQuery[K] } = {}
  const result: MessagesCommand = { command: 'messages', action: kind, query, dryRun: flags.has('--dry-run') }
  for (const [flag, field] of [['--session', 'sessionId'], ['--sender-session', 'senderSessionId'], ['--target-session', 'targetSessionId']] as const) {
    const value = flags.get(flag)
    if (value !== undefined) query[field] = identity(value) as NonNullable<MessageQuery[typeof field]>
  }
  if (flags.has('--node')) query.nodeId = identity(require('--node')) as NonNullable<MessageQuery['nodeId']>
  if (flags.has('--from')) query.from = time(require('--from'))
  if (flags.has('--to')) query.to = time(require('--to'))
  if (query.from !== undefined && query.to !== undefined && query.from >= query.to) invalid('Invalid message time range')
  if (flags.has('--cursor')) query.cursor = require('--cursor') as NonNullable<MessageQuery['cursor']>
  if (flags.has('--limit')) { query.limit = number(require('--limit'), true); if (query.limit === 0) invalid('Limit must be positive') }
  if (flags.has('--state')) {
    const states = require('--state').split(',')
    if (states.some(state => !['queued', 'injected', 'responded', 'withdrawn', 'invalidated', 'rejected'].includes(state)) || new Set(states).size !== states.length) invalid('Invalid message states')
    query.states = states as NonNullable<MessageQuery['states']>
  }
  if (flags.has('--include-terminal')) query.includeTerminal = true
  if (flags.has('--message-id')) result.messageId = identity(require('--message-id')) as MessageControlRequest['messageId']
  if (flags.has('--operation-id')) result.operationId = identity(require('--operation-id')) as OperationId
  if (flags.has('--expected-revision')) result.expectedRevision = number(require('--expected-revision'), true)
  if (flags.has('--priority')) {
    const priority = require('--priority')
    if (priority !== 'immediate' && priority !== 'steer' && priority !== 'queue') invalid('Invalid message priority')
    result.priority = priority
  }
  if (flags.has('--text')) { result.text = require('--text'); if (!result.text.trim()) invalid('Message text must not be blank') }
  if (flags.has('--reason')) { result.reason = require('--reason'); if (!result.reason.trim()) invalid('Invalidation reason must not be blank') }
  if (kind === 'send-batch' && result.dryRun && !flags.has('--class') && send.some(flag => flags.has(flag))) invalid('Send options require --class')
  if (kind === 'send' || kind === 'send-batch' && (!result.dryRun || flags.has('--class'))) {
    const messageClass = require('--class')
    if (messageClass === 'reply') result.classification = { messageClass, replyTo: identity(require('--reply-to')) as MessageControlRequest['messageId'] }
    else if (messageClass === 'handoff' || messageClass === 'notice') {
      if (flags.has('--reply-to')) invalid('Only replies accept --reply-to')
      result.classification = { messageClass }
    } else invalid('Invalid message class')
    if (!result.dryRun) require('--text')
    result.priority ??= messageClass === 'notice' ? 'queue' : 'steer'
    if (messageClass === 'notice' && result.priority !== 'queue') invalid('Notices require queue priority')
  } else if (flags.has('--class')) {
    const classes = require('--class').split(',')
    if (classes.some(value => !['handoff', 'notice', 'reply'].includes(value)) || new Set(classes).size !== classes.length) invalid('Invalid message classes')
    query.messageClasses = classes as NonNullable<MessageQuery['messageClasses']>
  }
  if (kind === 'send') {
    if (flags.has('--to-session') === flags.has('--to-name')) invalid('Exactly one of --to-session and --to-name is required')
    const node = query.nodeId === undefined ? {} : { nodeId: query.nodeId }
    const name = flags.get('--to-name')
    if (name !== undefined && (!name.trim() || /[*?\u0000-\u001f\u007f]/.test(name))) invalid('Target name must be explicit')
    result.target = name === undefined ? { ...node, sessionId: identity(require('--to-session')) as NonNullable<MessageAddress['sessionId']> } : { ...node, name: name.trim() }
  }
  if (kind === 'resolve' || kind === 'send-batch') result.recipients = addresses(require('--recipients'))
  if (['withdraw', 'edit', 'reprioritize', 'invalidate', 'status'].includes(kind)) require('--message-id')
  if (kind === 'operation') require('--operation-id')
  if (kind === 'edit') require('--text')
  if (kind === 'reprioritize') require('--priority')
  if (kind === 'invalidate') require('--reason')
  if (kind === 'unanswered') {
    query.unansweredOlderThanMinutes = number(require('--older-than-minutes'), false)
    query.messageClasses ??= ['handoff', 'reply']
    if (query.messageClasses.includes('notice')) invalid('Unanswered messages must be handoffs or replies')
  }
  if (kind === 'export') {
    if (require('--format') !== 'jsonl') invalid('Message exports support jsonl only')
    if (flags.has('--output')) result.outputPath = require('--output')
  }
  if (kind === 'watch') require('--session')
  return result
}

/** English message usage returned by the existing ledger execution entry. */
export const messagesHelp = `Usage: panedesk --profile ledger messages <command> [options]
Commands:
  send          --to-session ID | --to-name NAME --class handoff|notice|reply --text TEXT [--priority immediate|steer|queue] [--reply-to ID] [--node ID] [--operation-id ID]
  withdraw      --message-id ID [--operation-id ID] [--expected-revision N]
  edit          --message-id ID --text TEXT [--operation-id ID] [--expected-revision N]
  reprioritize  --message-id ID --priority immediate|steer|queue [--operation-id ID] [--expected-revision N]
  invalidate    --message-id ID --reason TEXT [--operation-id ID] [--expected-revision N]
  status        --message-id ID
  operation     --operation-id ID
  query         [filters]
  unanswered    --older-than-minutes N [filters] [--include-terminal]
  export        --format jsonl [--output PATH] [filters]
  resolve       --recipients JSON
  send-batch    --recipients JSON [--class handoff|notice|reply] [--text TEXT] [--priority immediate|steer|queue] [--reply-to ID] [--dry-run]
  watch         --session ID [--cursor CURSOR]
Filters: --session ID --sender-session ID --target-session ID --node ID --from ISO_TIME --to ISO_TIME --state LIST --class LIST --cursor CURSOR --limit N --include-terminal
Priorities default to steer for handoffs/replies and queue for notices. Replies require --reply-to.
Controls read the current revision unless --expected-revision is supplied. Offline acceptance is not completion.
Exports contain metadata and status records, never message bodies. Existing output files are not overwritten.
`
