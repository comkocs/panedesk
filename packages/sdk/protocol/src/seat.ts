/** Seat wire validation; authentication is supplied by the receiving adapter. */
import { SEAT_ERROR_CODES, SEAT_GATE_HOOKS } from '@panedesk/dsh-seat'
import type { SeatRequestMap } from './types.ts'

type Check = (value: unknown) => boolean
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text: Check = value => typeof value === 'string' && value.trim().length > 0
const integer: Check = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const optional = (check: Check): Check => value => value === undefined || check(value)
const choice = (...values: string[]): Check => value => typeof value === 'string' && values.includes(value)
const array = (check: Check): Check => value => Array.isArray(value) && value.every(check)
const fields = (checks: Record<string, Check>): Check => value => object(value)
  && Object.keys(value).every(key => Object.hasOwn(checks, key))
  && Object.entries(checks).every(([key, check]) => check(value[key]))
const candidate: Check = value => object(value) && text(value.seat) && text(value.sessionId) && string(value.title) && text(value.nodeId)
const failure: Check = value => object(value) && typeof value.code === 'string' && Object.hasOwn(SEAT_ERROR_CODES, value.code)
  && text(value.message) && text(value.alternative) && typeof value.retryable === 'boolean' && choice('none', 'committed', 'partial', 'unknown')(value.effectState)
const explicit: Check = value => text(value) && typeof value === 'string' && !/[*?\u0000-\u001f\u007f]/.test(value) && !['all', String.fromCodePoint(0x5168, 0x90e8)].includes(value.toLowerCase())
const node = { nodeId: optional(text) }
const operation = { ...node, operationId: text }
const session = { ...operation, sessionId: text }
const open = { ...operation, seat: explicit, origin: choice('manual', 'remote', 'engine'), taskId: optional(text),
  openingMode: optional(choice('auto', 'prefill')), expectedSeatRevision: optional(integer),
  existingChoice: optional(value => fields({ kind: choice('cancel') })(value) || fields({ kind: choice('switch', 'replace'), sessionId: text })(value)) }
const cursor = fields({ nodeId: text, sequence: integer, effectIndex: integer })
const filters = { ...node, projectId: optional(text), cursor: optional(text) }
const page = { limit: (value: unknown) => integer(value) && Number(value) > 0, cursor: optional(cursor) }
const pending = { queueItemId: text, expectedStateVersion: integer, operationId: text }
const boolean: Check = value => typeof value === 'boolean'
const string: Check = value => typeof value === 'string'
const nullable = (check: Check): Check => value => value === null || check(value)
const record = (check: Check): Check => value => object(value) && Object.values(value).every(check)
const json: Check = value => value === null || typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value)) || array(json)(value) || record(json)(value)
const microUsd: Check = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
const budget = fields({ windowBudgetUsd: optional(microUsd), dailyBudgetUsd: optional(microUsd) })
const directory = fields({ path: text, startup: boolean })
const seatText: Check = value => fields({ kind: choice('text'), text: string })(value)
  || fields({ kind: choice('file'), path: text, section: optional(text) })(value)
const schedule = fields({ after_seconds: optional(integer), every_seconds: optional(integer),
  at: optional(value => text(value) || fields({ date: text, time: text, time_zone: text })(value)),
  daily: optional(fields({ time: text, time_zone: text })),
  weekly: optional(fields({ time: text, time_zone: text, weekdays: array(integer) })),
  cron: optional(fields({ expression: text, time_zone: text })) })
const trigger: Check = value => object(value) && (
  fields({ kind: choice('schedule'), selector: schedule, timeZone: text })(value)
  || fields({ kind: choice('git'), repositoryId: text, ref: text })(value)
  || fields({ kind: choice('external'), sourceId: text, eventType: optional(text) })(value)
  || fields({ kind: choice('window-ended'), seat: text, on: choice('closed', 'can-close') })(value)
  || fields({ kind: choice('handoff-timeout'), timeoutMinutes: integer })(value)
  || fields({ kind: choice('manual'), origin: choice('manual', 'remote') })(value))
const definitionFields: Record<string, Check> = {
  schemaVersion: value => value === 1, revision: integer, seat: text, platform: choice('desktop', 'vscode', 'server'), node: text,
  projectId: text, directories: array(directory), memoryDirectories: array(text), opening: seatText, openingInstructionFiles: array(text),
  agentPreset: text, provider: text, model: text, reasoningEffort: text, permissionPreset: text, subscriptions: array(text),
  checkpointFiles: array(fields({ path: text, section: text, maxBytes: integer, required: boolean })), wakeTemplate: optional(seatText),
  maxOpenSessions: integer, maxActiveSubagents: integer, contextThresholdTokens: optional(integer), subagentContextThresholdTokens: integer,
  pollingThreshold: optional(integer), maxSleepSeconds: optional(integer), autoKeepAlive: optional(boolean),
  worktree: fields({ clientTreesPerSlot: integer, staleOnSettle: choice('notify'), lightByDefault: boolean, staleHours: integer }),
  rules: array(fields({ id: text, enabled: boolean, trigger, mode: optional(choice('off', 'remind', 'auto')),
    timeWindows: array(fields({ timeZone: text, start: text, end: text, weekdays: optional(array(integer)) })), exclusiveTags: array(text),
    modelAccountConcurrency: optional(array(fields({ accountLabel: text, limit: integer }))), timeoutMinutes: optional(integer),
    windowBudgetUsd: optional(microUsd), dailyBudgetUsd: optional(microUsd) })),
  source: optional(fields({ sourcePath: text, sourceFileHash: text, rowHash: text, mappingHash: text, columnHashes: record(text),
    baseline: record(json), authority: choice('import-source', 'seat-store') })),
}
const definition = fields(definitionFields)
const waitObject = fields({ kind: choice('subagent', 'job', 'schedule', 'message'), id: text })
const report = fields({ reportId: text, sessionId: text, canClose: boolean,
  waitingFor: array(fields({ kind: choice('subagent', 'job', 'schedule', 'message', 'other'), objectId: optional(text), summary: string })),
  nextOpen: fields({ when: value => fields({ kind: choice('unspecified') })(value)
    || fields({ kind: choice('at'), at: text })(value) || fields({ kind: choice('condition'), description: text })(value), prerequisites: array(text) }),
  submittedAt: text, stateVersion: integer })
const requestChecks: Record<keyof SeatRequestMap, Check> = {
  'seats/import.preview': fields({ format: choice('markdown', 'csv'), sourcePath: text, columnMap: record(text),
    defaults: fields(Object.fromEntries(Object.entries(definitionFields).map(([key, check]) => [key, optional(check)]))),
    table: optional(text) }),
  'seats/import.commit': fields({ planId: text, selectedRows: array(integer), expectedRevision: integer, operationId: text }),
  'seats/setAuthority': fields({ expectedRevision: integer, authority: choice('import-source', 'seat-store'), authorizationRef: text, operationId: text }),
  'seats/report.submit': fields({ report, operationId: text, toolCallId: optional(text), rootCallId: optional(text) }),
  'seats/wait.register': fields({ waitId: text, sessionId: text, mode: choice('any', 'all'), objects: array(waitObject), operationId: text,
    toolCallId: optional(text), rootCallId: optional(text) }),
  'seats/wait.cancel': fields({ waitId: text, sessionId: text, expectedStateVersion: integer, operationId: text }),
  'seats/list': fields(filters),
  'seats/open': fields(open),
  'seats/openBatch': value => fields({ ...operation, origin: choice('manual', 'remote'), openingMode: optional(choice('auto', 'prefill')), seats: array(explicit) })(value)
    && object(value) && Array.isArray(value.seats) && value.seats.length > 0 && new Set(value.seats).size === value.seats.length,
  'seats/renew': fields(session),
  'seats/close': fields({ ...session, expectedStateVersion: integer }),
  'seats/replace': fields(session),
  'seats/rename': fields({ ...session, title: text }),
  'seats/wake': fields({ ...operation, seat: explicit, sessionId: optional(text) }),
  'seats/operation': fields({ operationId: text }),
  'seats/binding': fields({ ...node, sessionId: text }),
  'seats/setProjectMode': fields({ projectId: text, mode: choice('off', 'remind', 'auto'), expectedRevision: integer, operationId: text }),
  'seats/pending': fields({ ...page, projectId: optional(text), seat: optional(explicit) }),
  'seats/approve': fields(pending),
  'seats/cancel': fields(pending),
  'seats/gates': fields({ ...page, gateId: optional(text), hook: optional(choice(...SEAT_GATE_HOOKS)) }),
  'seats/nodeStatus': fields({}),
}

const importRow = fields({ row: integer, seat: nullable(text), definition: nullable(definition), rowHash: text, columnHashes: record(text),
  action: choice('create', 'update', 'retain', 'conflict', 'tombstone', 'invalid'), selected: boolean,
  differences: array(fields({ field: text, baseline: json, local: json, source: json, conflict: boolean })), diagnostics: array(failure) })
const wait = fields({ waitId: text, sessionId: text, mode: choice('any', 'all'), objects: array(waitObject),
  observations: array(fields({ object: waitObject, outcome: choice('completed', 'failed', 'cancelled', 'owner-lost', 'unknown'),
    observedAt: text, watermark: integer, durability: choice('durable', 'best-effort') })),
  phase: choice('registered', 'satisfied', 'woken', 'cancelled'), operationId: text, wakeOperationId: text,
  toolCallId: optional(text), rootCallId: optional(text), stateVersion: integer, durability: choice('durable', 'best-effort') })
const binding: Check = value => fields({ kind: choice('free'), sessionId: text, nodeId: text, identitySource: choice('free') })(value)
  || fields({ kind: choice('seat'), sessionId: text, seat: text, projectId: text, nodeId: text, bindingSource: choice('seat-definition'),
    identitySource: choice('settings', 'inherited'), openOperationId: text, seatRevision: integer, taskId: optional(text), relatedTaskIds: array(text),
    directories: array(directory), memoryDirectories: array(text), subscriptions: array(text), openingDigest: text })(value)
const busy = fields({ kind: choice('turn', 'subagent', 'job', 'approval', 'plan-review', 'answer', 'wait', 'ticket', 'inbox', 'owner-unknown'), objectId: optional(text), summary: string })
const nonnegative: Check = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const windowView = fields({ seat: text, sessionId: text, title: string, nodeId: text,
  status: nullable(choice('running', 'idle', 'approval-pending', 'plan-review-pending', 'answer-pending', 'completed')),
  engineStatus: choice('active', 'prefilled', 'budget-stopped', 'configuring', 'closing', 'unknown'), evidence: choice('complete', 'unknown'),
  idleMinutes: nullable(nonnegative), runningSubagents: integer, activeJobs: integer, canRenew: boolean, renewRejection: nullable(failure),
  busyReasons: array(busy), stateVersion: integer, seatBinding: nullable(binding) })
const cache = fields({ lastActivityAt: nullable(text), cacheTtlMs: nullable(nonnegative), prefixDigest: nullable(text),
  observedAt: text, reusableRequest: boolean })
const openPhase = choice('intent', 'creating', 'created', 'configuring', 'opening-pending', 'active', 'opening-failed')
const replacePhase = choice('opening', 'created', 'configuring', 'first-turn-pending', 'awaiting-old-idle', 'closing-old', 'completed', 'closing-new')
const permit = fields({ permitId: text, replacementId: text, oldSessionId: text, newSessionId: text,
  state: choice('issued', 'first-turn-running', 'expired-success', 'expired-failure'), issuedAt: text, expiredAt: nullable(text), ownerEpoch: text })
const pendingReason = choice('approval', 'project-off', 'time-window', 'node-capacity', 'seat-capacity', 'exclusive-tag', 'budget-full', 'budget-unverifiable', 'provider-unavailable')
const handoff = { messageId: text, senderSessionId: text, deadlineVersion: integer, deadlineAt: text,
  timeoutMinutes: nonnegative, wakeOperationId: text }
const evidence: Check = value => fields({ kind: choice('schedule'), scheduleId: text, scheduledAt: text })(value)
  || fields({ kind: choice('git'), repositoryId: text, ref: text, oldObjectId: nullable(text), newObjectId: nullable(text), observationSequence: integer })(value)
  || fields({ kind: choice('external'), eventType: text })(value)
  || fields({ kind: choice('window-ended'), sessionId: text, endedEventId: text, reportId: nullable(text), origin: choice('closed', 'can-close') })(value)
  || fields({ kind: choice('handoff-timeout'), ...handoff })(value)
  || fields({ kind: choice('manual'), origin: choice('manual', 'remote'), operationId: text })(value)
const sourceEnvelope = fields({ triggerId: text, sourceId: text, eventId: optional(text), kind: choice('schedule', 'git', 'external', 'window-ended', 'handoff-timeout', 'manual'),
  evidence, seat: text, projectId: text, receivedAt: text, dataDigest: text, data: json, taskId: optional(text), callbackRef: text,
  cause: optional(fields({ eventId: text, depth: integer })) })
const pendingItem = fields({ queueItemId: text, seat: text, projectId: text, triggerKind: choice('schedule', 'git', 'external', 'window-ended', 'handoff-timeout', 'manual'),
  action: choice('open', 'wake-sender', 'replace'), handoffTimeout: optional(fields(handoff)), sequence: integer,
  effectiveMode: choice('off', 'remind', 'auto'), reason: pendingReason, blockedBy: array(text), sources: array(sourceEnvelope), relatedTaskIds: array(text), queuedAt: text, stateVersion: integer })

/** Identify the additive seat method set without accepting inherited object keys.
 * @param method - untrusted RPC method name.
 * @returns whether the method belongs to this extension.
 */
export function isSeatMethod(method: string): method is keyof SeatRequestMap { return Object.hasOwn(requestChecks, method) }

/** Validate wire parameters without accepting caller-supplied authority.
 * @param method - known seat method.
 * @param value - untrusted parameters.
 * @returns validated request or a validation error before provider invocation.
 */
export function decodeSeatRequest<M extends keyof SeatRequestMap>(method: M, value: unknown): SeatRequestMap[M]['params'] {
  if (!requestChecks[method](value)) throw new TypeError(`Invalid ${method} parameters`)
  return value as SeatRequestMap[M]['params']
}

/** Validate result discrimination before exposing it to SDK callers.
 * @param method - requested operation.
 * @param value - untrusted response.
 * @returns the decoded response; unknown variants are rejected.
 */
export function decodeSeatResult<M extends keyof SeatRequestMap>(method: M, value: unknown): SeatRequestMap[M]['result'] {
  const fail = (): never => { throw new TypeError(`Invalid ${method} result`) }
  if (method === 'seats/binding' && value === null) return value
  if (!object(value)) return fail()
  if (value.status === 'rejected') {
    if (['seats/operation', 'seats/nodeStatus', 'seats/pending', 'seats/gates'].includes(method)) return fail()
    if (method === 'seats/renew' && !cache(value.cacheEvidence)) return fail()
    if (!object(value.error) || typeof value.error.code !== 'string' || !Object.hasOwn(SEAT_ERROR_CODES, value.error.code)
      || !text(value.error.message) || !text(value.error.alternative) || typeof value.error.retryable !== 'boolean'
      || !choice('none', 'committed', 'partial', 'unknown')(value.error.effectState)) return fail()
    return value as SeatRequestMap[M]['result']
  }
  if (method === 'seats/import.preview' && !fields({ planId: text, sourceFileHash: text, mappingHash: text, baseRevision: integer, rows: array(importRow) })(value)) return fail()
  if (method === 'seats/import.commit' && !fields({ status: choice('committed'), revision: integer, rows: array(importRow) })(value)) return fail()
  if (method === 'seats/setAuthority' && !fields({ status: choice('saved'), revision: integer })(value)) return fail()
  if (method === 'seats/report.submit' && !fields({ status: choice('recorded', 'revoked'), reportId: text, stateVersion: integer })(value)) return fail()
  if (method === 'seats/wait.register' && !fields({ status: choice('registered'), wait })(value)) return fail()
  if (method === 'seats/wait.cancel' && !fields({ status: choice('cancelled', 'already-settled'), wait })(value)) return fail()
  const variants: Partial<Record<keyof SeatRequestMap, readonly string[]>> = {
    'seats/list': ['listed'], 'seats/open': ['opened', 'prefilled', 'choice-required', 'switched', 'cancelled', 'queued'],
    'seats/openBatch': ['processed'], 'seats/renew': ['renewed', 'uncertain'], 'seats/close': ['closed', 'busy', 'conflict'],
    'seats/replace': ['queued', 'replacing', 'failed'], 'seats/rename': ['renamed'],
    'seats/wake': ['sent', 'stored-budget-stopped', 'opened', 'choice-required'],
    'seats/setProjectMode': ['saved'], 'seats/approve': ['approved'], 'seats/cancel': ['cancelled'],
  }
  const statuses = variants[method]
  if (statuses && (typeof value.status !== 'string' || !statuses.includes(value.status))) return fail()
  if (method === 'seats/list' && (!Array.isArray(value.sessions) || !array(text)(value.unopenedSeats) || typeof value.complete !== 'boolean' || !text(value.snapshotAt))) return fail()
  if (method === 'seats/open' && ['opened', 'prefilled'].includes(String(value.status))
    && (!text(value.sessionId) || !text(value.seat) || !text(value.nodeId) || !string(value.title)
      || !object(value.budget) || !integer(value.stateVersion))) return fail()
  if (method === 'seats/openBatch') {
    if (!Array.isArray(value.results)) return fail()
    for (const entry of value.results) {
      if (!fields({ seat: text, result: object })(entry) || !object(entry)) return fail()
      decodeSeatResult('seats/open', entry.result)
    }
  }
  if (method === 'seats/pending' || method === 'seats/gates') {
    if (!Array.isArray(value[method === 'seats/pending' ? 'items' : 'gates']) || typeof value.complete !== 'boolean' || !integer(value.watermark)) return fail()
  }
  if (method === 'seats/nodeStatus' && (!text(value.nodeId) || !text(value.nodeName) || !choice('running', 'recovering', 'unavailable')(value.engine)
    || !integer(value.openEngineWindows) || !(value.limit === null || integer(value.limit)))) return fail()
  if (value.status === 'queued' && (!text(value.queueItemId) || !integer(value.sequence)
    || !choice('approval', 'project-off', 'time-window', 'node-capacity', 'seat-capacity', 'exclusive-tag', 'budget-full', 'budget-unverifiable', 'provider-unavailable')(value.reason)
    || (method === 'seats/open' && !array(text)(value.blockedBy)))) return fail()
  if (method === 'seats/open' && ['opened', 'prefilled'].includes(String(value.status))
    && (!text(value.nodeName) || !text(value.phase) || !array(text)(value.callbackIds) || (value.status === 'prefilled' && typeof value.draft !== 'string'))) return fail()
  if (method === 'seats/open' && value.status === 'switched' && !candidate(value.window)) return fail()
  if (value.status === 'choice-required' && (!array(candidate)(value.candidates)
    || (method === 'seats/open' && (JSON.stringify(value.choices) !== '["switch","replace","cancel"]' || value.defaultChoice !== 'switch')))) return fail()
  if (method === 'seats/renew' && (!object(value.cacheEvidence) || (value.status === 'renewed' ? !text(value.sessionId) : !failure(value.error)))) return fail()
  if (method === 'seats/close') {
    if (value.status === 'closed' && (!text(value.sessionId) || value.phase !== 'closed' || !text(value.endedAt) || !integer(value.stateVersion))) return fail()
    if (value.status === 'busy' && (!text(value.sessionId) || !array(object)(value.busyReasons))) return fail()
    if (value.status === 'conflict' && (!integer(value.expectedStateVersion) || !integer(value.actualStateVersion))) return fail()
  }
  if (method === 'seats/replace') {
    if (!text(value.replacementId) || !text(value.oldSessionId) || !text(value.phase)) return fail()
    if (value.status === 'replacing' && (!text(value.newSessionId) || !object(value.permit))) return fail()
    if (value.status === 'failed' && (!(value.newSessionId === null || text(value.newSessionId)) || !failure(value.cause)
      || !choice('not-created', 'closed', 'pending')(value.cleanup))) return fail()
  }
  if (method === 'seats/rename' && (!text(value.sessionId) || !object(value.title))) return fail()
  if (method === 'seats/wake') {
    if (value.status === 'opened') decodeSeatResult('seats/open', value.result)
    if (['sent', 'stored-budget-stopped'].includes(String(value.status)) && (!text(value.sessionId) || !text(value.messageId) || !text(value.operationId))) return fail()
  }
  if (method === 'seats/binding') {
    if (!text(value.sessionId) || !text(value.nodeId) || !choice('free', 'seat')(value.kind)) return fail()
    if (value.kind === 'free' && value.identitySource !== 'free') return fail()
    if (value.kind === 'seat' && (!text(value.seat) || !text(value.projectId) || value.bindingSource !== 'seat-definition'
      || !choice('settings', 'inherited')(value.identitySource) || !text(value.openOperationId) || !integer(value.seatRevision)
      || !array(text)(value.relatedTaskIds) || !array(object)(value.directories) || !array(text)(value.memoryDirectories)
      || !array(text)(value.subscriptions) || !text(value.openingDigest))) return fail()
  }
  if (method === 'seats/operation') {
    if (!choice('missing', 'pending', 'settled')(value.status)) return fail()
    if (value.status === 'pending' && (!text(value.phase) || !integer(value.stateVersion))) return fail()
    if (value.status === 'settled' && (!object(value.result) || !text(value.result.status))) return fail()
  }
  if (method === 'seats/list' && (!array(windowView)(value.sessions) || !optional(text)(value.nextCursor))) return fail()
  if (method === 'seats/open' && ['opened', 'prefilled'].includes(String(value.status)) && (!budget(value.budget) || !openPhase(value.phase))) return fail()
  if (method === 'seats/binding' && !binding(value)) return fail()
  if (method === 'seats/renew' && !cache(value.cacheEvidence)) return fail()
  if (method === 'seats/close' && value.status === 'busy' && !array(busy)(value.busyReasons)) return fail()
  if (method === 'seats/replace') {
    if (value.status === 'queued' && value.phase !== 'queued') return fail()
    if (value.status === 'replacing' && (!replacePhase(value.phase) || !permit(value.permit))) return fail()
    if (value.status === 'failed' && (value.phase !== 'failed' || !choice('replacement-open-failed', 'replacement-first-turn-failed', 'replacement-cleanup-failed')(value.reason))) return fail()
  }
  if (method === 'seats/rename' && !fields({ title: text, messageSeqs: array(integer), eventSeq: integer, updatedAt: nonnegative,
    source: source => fields({ kind: choice('fallback', 'user') })(source)
      || fields({ kind: choice('provider'), provider: text, model: optional(fields({ provider: text, model: text })) })(source) })(value.title)) return fail()
  if (method === 'seats/setProjectMode' && !fields({ projectId: text, mode: choice('off', 'remind', 'auto'), modeChosen: boolean, revision: integer })(value.policy)) return fail()
  if (['seats/approve', 'seats/cancel'].includes(method) && (!text(value.queueItemId) || !integer(value.stateVersion))) return fail()
  if (method === 'seats/nodeStatus' && !nullable(text)(value.readyAt)) return fail()
  if (method === 'seats/pending' && !array(pendingItem)(value.items)) return fail()
  if (method === 'seats/gates' && !array(fields({ definition: fields({ id: text, name: text, hook: choice(...SEAT_GATE_HOOKS),
    criterion: fields({ type: text, parameters: record(json) }), alternative: text, expiresAt: nullable(text), enabled: boolean,
    revision: integer, order: value => typeof value === 'number' && Number.isSafeInteger(value) }),
  hitCount: integer, expired: boolean, lastHitAt: nullable(text), watermark: integer }))(value.gates)) return fail()
  if (['seats/pending', 'seats/gates'].includes(method) && !optional(cursor)(value.nextCursor)) return fail()
  if (method === 'seats/operation') {
    if (value.status === 'pending' && !choice('intent', 'creating', 'created', 'configuring', 'opening-pending', 'active', 'opening-failed',
      'admission', 'rechecking', 'archiving', 'renaming', 'flushing', 'closed', 'queued', 'opening', 'first-turn-pending', 'awaiting-old-idle', 'closing-old', 'completed', 'closing-new', 'failed')(value.phase)) return fail()
    if (value.status === 'settled') {
      const methods = ['seats/open', 'seats/close', 'seats/replace', 'seats/wake', 'seats/renew', 'seats/rename'] as const
      if (!methods.some((operation) => {
        try { decodeSeatResult(operation, value.result); return true } catch (error) { void error; return false }
      })) return fail()
    }
  }
  return value as SeatRequestMap[M]['result']
}
