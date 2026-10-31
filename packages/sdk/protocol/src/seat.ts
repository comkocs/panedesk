/** Seat wire validation; authentication is supplied by the receiving adapter. */
import {
  SEAT_ERROR_CODES, SEAT_GATE_HOOKS, NODE_WORK_CHAIN_MAX_CODE_BYTES,
  NODE_WORK_CHAIN_MAX_REASON_BYTES, NODE_WORK_CHAIN_REASON_CODES, NODE_WORK_CHAIN_METHODS, NODE_WORK_CHAIN_MAX_FRAME_BYTES,
} from '@panedesk/dsh-seat'
import type { NodeWorkChainMethod, NodeWorkChainMethodMap, SeatFailureCause, NodeDelegationEvidenceRequest, NodeDelegationEvidenceResult } from '@panedesk/dsh-seat'
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
const diagnosticCode: Check = value => typeof value === 'string' && value.length <= NODE_WORK_CHAIN_MAX_CODE_BYTES
  && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
const diagnosticReason: Check = value => typeof value === 'string' && value.trim().length > 0
  && new TextEncoder().encode(value).length <= NODE_WORK_CHAIN_MAX_REASON_BYTES && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
const failureCause = fields({ domain: diagnosticCode, code: diagnosticCode, reason: diagnosticReason,
  effectState: choice('none', 'committed', 'partial', 'unknown'), retryable: value => typeof value === 'boolean',
  operationId: text, nodeId: text, reasonCode: optional(choice(...NODE_WORK_CHAIN_REASON_CODES)) })
const cancellationCause = fields({ domain: diagnosticCode, code: diagnosticCode, reason: diagnosticReason,
  effectState: choice('none', 'committed', 'partial', 'unknown'), retryable: value => typeof value === 'boolean',
  operationId: text, nodeId: text, reasonCode: choice('queue-item-dispatched', 'queue-item-opened', 'queue-item-unknown') })
const seatFailureCause: Check = value => failureCause(value) || cancellationCause(value)
const candidate: Check = value => object(value) && text(value.seat) && text(value.sessionId) && string(value.title) && text(value.nodeId)
const failure: Check = value => object(value) && typeof value.code === 'string' && Object.hasOwn(SEAT_ERROR_CODES, value.code)
  && text(value.message) && text(value.alternative) && typeof value.retryable === 'boolean' && choice('none', 'committed', 'partial', 'unknown')(value.effectState)
  && optional(seatFailureCause)(value.cause)
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
const cancellationReason: Check = value => typeof value === 'string' && new TextEncoder().encode(value).length <= 512
  && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
const cancellationRecord = fields({ authorizationId: text, principalId: text,
  kind: choice('model-tool-call', 'human', 'engine', 'local-operator', 'node-delegation', 'plugin'),
  operationId: text, queueItemId: text, cancelledAt: value => typeof value === 'string' && Number.isFinite(Date.parse(value)),
  stateVersion: integer, reason: optional(cancellationReason), reasonPresent: value => typeof value === 'boolean' })
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
const uniqueExplicit: Check = value => Array.isArray(value) && value.length > 0
  && value.every(explicit) && new Set(value).size === value.length
const remoteAdmission = fields({ allowOpen: value => value === true, sourceNodeIds: uniqueExplicit,
  sourceIds: uniqueExplicit, principalIds: uniqueExplicit,
  methods: value => uniqueExplicit(value) && array(choice('engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'))(value),
  policyRevision: value => integer(value) && Number(value) > 0 })
const definitionFields: Record<string, Check> = {
  remoteAdmission: optional(remoteAdmission),
  schemaVersion: value => value === 1, revision: integer, seat: text, platform: choice('desktop', 'vscode', 'server'), node: text,
  projectId: text, directories: array(directory), memoryDirectories: array(text), opening: seatText, openingInstructionFiles: array(text),
  agentPreset: text, provider: text, model: text, reasoningEffort: text, permissionPreset: text, subscriptions: array(text),
  checkpointFiles: array(fields({ path: text, section: text, mode: optional(choice('section', 'file')), maxBytes: integer, required: boolean })), wakeTemplate: optional(seatText),
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
  'seats/cancel': fields({ ...pending, reason: optional(cancellationReason) }),
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
    directories: array(directory), memoryDirectories: array(text), subscriptions: array(text), openingDigest: text,
    staffBinding: optional(value => staffBinding(value)) })(value)
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
const openingReference = fields({ providerId: text, reference: text, revision: text })
const scopeEvidence: Check = value => fields({ status: choice('unknown'), taskId: text, reason: text, alternative: choice('serial') })(value)
  || fields({ status: choice('known'), taskId: text, revision: text, repositoryId: text, baseRevision: text,
    entries: array(fields({ kind: choice('file', 'directory', 'pattern'), path: text, access: choice('read', 'write') })),
    patternSyntax: choice('literal', 'glob-v1'), caseSensitive: boolean })(value)
const openingSnapshot = fields({ reference: openingReference, text: string, digest: text, revision: text,
  taskIds: array(text), scopeEvidence: array(scopeEvidence) })
const staffBinding = fields({ staffId: text, seat: text, taskIds: array(text), evidenceRef: text, revision: text, verifiedAt: text })
const scopeReservation = fields({ reservationId: text, sourceId: text, sourceOwnerNodeId: text, ownerEpoch: text,
  operationId: text, taskIds: array(text), snapshotDigest: text, policyRevision: integer })
const chainContext = fields({ snapshot: openingSnapshot, staffBinding: optional(staffBinding), scopeReservation, openingMode: choice('auto', 'prefill') })
const callbackPath: Check = value => fields({ kind: choice('source'), sourceId: text })(value)
  || fields({ kind: choice('opening-context'), reference: openingReference, operationId: text })(value)
const chainRoute = fields({ sourceId: text, sourceOwnerNodeId: text, ownerEpoch: text, triggerId: nullable(text),
  originalOperationId: text, targetNodeId: text, snapshotDigest: text, callbackPath,
  modeCeiling: fields({ mode: choice('off', 'remind', 'auto'), policy: fields({ sourceId: text, projectId: text, revision: integer, ruleId: optional(text) }) }) })
const modelEvidence: Check = value => fields({ status: choice('present'), provider: text, model: text,
  kind: choice('request/header', 'model/selection'), sessionId: text, nodeId: text, recordRef: text, observedAt: text })(value)
  || fields({ status: choice('missing'), sessionId: nullable(text), nodeId: text, observedAt: text })(value)
const sourceEnvelope = fields({ triggerId: text, sourceId: text, eventId: optional(text), kind: choice('schedule', 'git', 'external', 'window-ended', 'handoff-timeout', 'manual'),
  evidence, seat: text, projectId: text, receivedAt: text, dataDigest: text, data: json, taskId: optional(text), callbackRef: text,
  cause: optional(fields({ eventId: text, depth: integer })), openingContext: optional(openingReference),
  relatedTaskIds: optional(array(text)) })
const frozenOpen = fields({ definition, title: string, openingMode: choice('auto', 'prefill'), recheckRequired: optional(value => value === true),
  openingContext: optional(openingSnapshot), nodeWorkChain: optional(value => acceptedData(value)),
  frozenOpening: optional(fields({ text: string, digest: text, variables: fields({ seat: text, date: text, taskId: nullable(text) }) })) })
const pendingItem = fields({ frozenOpen: optional(frozenOpen), replacementId: optional(text), queueItemId: text, seat: text, projectId: text, triggerKind: choice('schedule', 'git', 'external', 'window-ended', 'handoff-timeout', 'manual'),
  action: choice('open', 'wake-sender', 'replace'), handoffTimeout: optional(fields(handoff)), sequence: integer,
  effectiveMode: choice('off', 'remind', 'auto'), reason: pendingReason, blockedBy: array(text), sources: array(sourceEnvelope), relatedTaskIds: array(text), queuedAt: text, stateVersion: integer })

const callbackBase = { callbackId: text, sourceId: text, triggerId: nullable(text), stateVersion: integer,
  seat: text, title: nullable(string), sessionId: nullable(text), nodeId: text, nodeName: text, budget,
  taskId: optional(text), relatedTaskIds: array(text) }
const budgetSnapshot = fields({ sessionId: text, seat: text, currency: choice('USD'), costState: choice('known', 'unknown'),
  windowCost: nullable(microUsd), dailyCost: nullable(microUsd), limits: budget, dayKey: text, budgetTimeZone: text,
  inFlightUnknown: integer, watermark: integer, budgetRevision: integer })
const callback: Check = value => fields({ ...callbackBase, kind: choice('opened'), sessionId: text, title: string })(value)
  || fields({ ...callbackBase, kind: choice('opening-failed', 'rejected'), reason: failure })(value)
  || fields({ ...callbackBase, kind: choice('window-ended'), reason: choice('manual', 'self-report', 'replaced', 'owner-dead', 'replacement-failed'),
    endedAt: text, selfReport: nullable(report), selfReportStatus: choice('submitted', 'not-submitted', 'revoked'), reportId: optional(text) })(value)
  || fields({ ...callbackBase, kind: choice('budget-stopped'), budgetSnapshot })(value)
  || fields({ ...callbackBase, kind: choice('replacement-failed'), replacementId: text, oldSessionId: text, newSessionId: nullable(text),
    reason: choice('replacement-open-failed', 'replacement-first-turn-failed', 'replacement-cleanup-failed'), cause: failure, cleanup: choice('not-created', 'closed', 'pending') })(value)
const chainKey = fields({ sourceNodeId: text, principalId: text, sourceId: text, ownerEpoch: text,
  method: choice(...NODE_WORK_CHAIN_METHODS.filter(method => method !== 'seat.definitionRevision')), operationId: text, callbackId: optional(text) })
const acceptedData = fields({ capability: choice('node-work-chain/v1'), route: chainRoute, openingContext: chainContext,
  expectedSeatRevision: integer, authorizationRef: text, payloadDigest: text, operationKey: chainKey, trigger: nullable(sourceEnvelope) })
const frozen = { openingContext: chainContext, expectedSeatRevision: integer, route: chainRoute }
const chainRequests: Record<NodeWorkChainMethod, Check> = {
  'seat.definitionRevision': fields({ seat: explicit, sourceId: text, sourceOwnerNodeId: text, ownerEpoch: text,
    openingMethod: choice('engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'), taskIds: array(text) }),
  'engine.acceptFrozen': fields({ ...frozen, envelope: sourceEnvelope }),
  'seat.openFrozen': fields({ ...frozen, request: fields(open) }),
  'seat.wakeFrozen': fields({ ...frozen, request: requestChecks['seats/wake'] }),
  'source.prepareOpening': fields({ sourceId: text, sourceOwnerNodeId: text, ownerEpoch: text, reference: openingReference,
    seat: explicit, taskIds: array(text), operationId: text, targetNodeId: text, expectedSeatRevision: integer, openingMode: choice('auto', 'prefill') }),
  'source.checkAdmission': fields({ scopeReservation, route: chainRoute, taskIds: array(text), operationId: text, executionNodeId: text }),
  'source.deliverCallback': fields({ callback, route: chainRoute, modelEvidence, payloadDigest: text }),
  'chain.operation': fields({ key: chainKey, payloadDigest: text }),
}
const rejected = fields({ status: choice('rejected'), error: failure })
const callbackPendingReason = optional(choice('owner-recovering', 'writeback-pending', 'writeback-outcome-unknown', 'desk-unreachable'))
const chainResults: Record<NodeWorkChainMethod, Check> = {
  'seat.definitionRevision': value => rejected(value) || fields({ status: choice('found'), nodeId: text, seat: explicit,
    revision: value => integer(value) && Number(value) > 0 })(value),
  'engine.acceptFrozen': value => rejected(value)
    || fields({ status: choice('accepted', 'coalesced'), triggerId: text, queueItemId: text, sequence: integer })(value)
    || fields({ status: choice('duplicate'), triggerId: text, originalTriggerId: text, queueItemId: nullable(text) })(value),
  'seat.openFrozen': value => seatResultMatches('seats/open', value),
  'seat.wakeFrozen': value => seatResultMatches('seats/wake', value),
  'source.prepareOpening': value => rejected(value) || fields({ status: choice('prepared'), ...frozen })(value),
  'source.checkAdmission': value => fields({ status: choice('allowed'), policyRevision: integer })(value)
    || fields({ status: choice('denied', 'unknown'), policyRevision: nullable(integer), error: failure })(value),
  'source.deliverCallback': value => rejected(value)
    || fields({ status: choice('pending'), callbackId: text, payloadDigest: text, pendingReason: callbackPendingReason })(value)
    || fields({ status: choice('committed'), callbackId: text, payloadDigest: text })(value)
    || fields({ status: choice('paused'), callbackId: text, payloadDigest: text, error: failure })(value),
  'chain.operation': value => rejected(value) || fields({ status: choice('missing') })(value)
    || fields({ status: choice('pending'), effectState: choice('none', 'unknown'), pendingReason: callbackPendingReason })(value)
    || (fields({ status: choice('settled'), method: choice(...NODE_WORK_CHAIN_METHODS.filter(method => method !== 'chain.operation' && method !== 'seat.definitionRevision')), result: object })(value)
      && object(value) && chainResults[value.method as Exclude<NodeWorkChainMethod, 'chain.operation'>](value.result)),
}
function seatResultMatches(method: keyof SeatRequestMap, value: unknown): boolean {
  try { decodeSeatResult(method, value); return true } catch (error) { void error; return false }
}

/** Validate original refusal diagnostics without changing their bytes.
 * @param value - Untrusted optional diagnostic object.
 * @returns Validated diagnostic or a protocol error.
 */
export function decodeSeatFailureCause(value: unknown): SeatFailureCause {
  if (!failureCause(value)) throw new TypeError('Invalid refusal cause')
  return value as SeatFailureCause
}
/** Validate one closed chain request; authentication remains owned by its receiver.
 * @param method - Negotiated method name.
 * @param value - Complete untrusted business payload.
 * @returns Original payload without defaults or projection loss.
 */
export function decodeNodeWorkChainRequest<M extends NodeWorkChainMethod>(method: M, value: unknown): NodeWorkChainMethodMap[M]['request'] {
  if (!Object.hasOwn(chainRequests, method) || !chainRequests[method](value)) throw new TypeError(`Invalid ${method} parameters`)
  return value as NodeWorkChainMethodMap[M]['request']
}
/** Validate each method's result, including exact settled-method discrimination.
 * @param method - Original request method.
 * @param value - Untrusted result.
 * @returns Original validated result.
 */
export function decodeNodeWorkChainResult<M extends NodeWorkChainMethod>(method: M, value: unknown): NodeWorkChainMethodMap[M]['result'] {
  if (!Object.hasOwn(chainResults, method) || !chainResults[method](value)) throw new TypeError(`Invalid ${method} result`)
  return value as NodeWorkChainMethodMap[M]['result']
}
const evidenceRequest = fields({ authorizationRef: text, method: choice(...NODE_WORK_CHAIN_METHODS), operationId: text,
  payloadDigest: text, sourceNodeId: text, targetNodeId: text })
const authorizationFact = fields({ authorizationId: text, kind: choice('model-tool-call', 'human', 'engine', 'local-operator', 'node-delegation', 'plugin'),
  principalId: text, origin: choice('manual', 'remote', 'engine'), nodeId: text, sourceNodeId: optional(text), sessionId: optional(text), seat: optional(text),
  taskIds: array(text), operationId: text, callId: optional(text), rootCallId: optional(text), policyRevision: integer,
  decision: choice('allowed', 'denied'), reasonCode: diagnosticCode, requestDigest: text, delegatedBy: optional(text), checkedAt: text })
/** Validate the same-channel exact evidence lookup without issuing another delegation.
 * @param value - Untrusted control request.
 * @returns Validated lookup identity.
 */
export function decodeNodeDelegationEvidenceRequest(value: unknown): NodeDelegationEvidenceRequest {
  if (!evidenceRequest(value)) throw new TypeError('Invalid evidence request')
  return value as NodeDelegationEvidenceRequest
}
/** Validate independently retained evidence or a sanitized refusal.
 * @param value - Untrusted control response.
 * @returns Validated retained evidence; matching against the request belongs to the receiver.
 */
export function decodeNodeDelegationEvidenceResult(value: unknown): NodeDelegationEvidenceResult {
  if (!fields({ status: choice('retained'), request: evidenceRequest, fact: authorizationFact, expiresAt: text, revoked: value => value === false })(value)
    && !fields({ status: choice('rejected'), cause: failureCause })(value)) throw new TypeError('Invalid evidence result')
  return value as NodeDelegationEvidenceResult
}

/** Enforce the complete serialized frame limit, including wrappers and authorization.
 * @param frame - Complete JSON frame, not only its business payload.
 * @param limits - Local and both negotiated peer limits; their minimum applies.
 * @returns Serialized frame when it fits without truncation or fragmentation.
 */
export function encodeNodeWorkChainFrame(frame: unknown, limits: readonly number[]): string {
  if (limits.length !== 3 || !limits.every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Invalid frame limits')
  const encoded: unknown = JSON.stringify(frame)
  if (typeof encoded !== 'string') throw new TypeError('Invalid JSON frame')
  if (new TextEncoder().encode(encoded).length > Math.min(NODE_WORK_CHAIN_MAX_FRAME_BYTES, ...limits)) throw new TypeError('Frame too large')
  return encoded
}

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
      || !choice('none', 'committed', 'partial', 'unknown')(value.error.effectState)
      || !optional(seatFailureCause)(value.error.cause)) return fail()
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
      if (object(value.result) && 'cancellation' in value.result) {
        if (!fields({ status: choice('cancelled'), cancellation: cancellationRecord })(value.result)) return fail()
        return value as SeatRequestMap[M]['result']
      }
      const methods = ['seats/open', 'seats/close', 'seats/replace', 'seats/wake', 'seats/renew', 'seats/rename'] as const
      if (!methods.some((operation) => {
        try { decodeSeatResult(operation, value.result); return true } catch (error) { void error; return false }
      })) return fail()
    }
  }
  return value as SeatRequestMap[M]['result']
}
