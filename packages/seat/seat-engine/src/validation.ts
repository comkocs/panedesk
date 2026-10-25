/** Every persisted payload is checked before replay can mutate a projection. */
import { SEAT_ERROR_CODES, type EngineEventKind, type EngineEffect } from '@panedesk/dsh-seat'

type Check = (value: unknown) => boolean
const text: Check = value => typeof value === 'string'
const id: Check = value => text(value) && value !== ''
const number: Check = value => typeof value === 'number' && Number.isFinite(value)
const integer: Check = value => number(value) && Number.isSafeInteger(value) && Number(value) >= 0
const positive: Check = value => integer(value) && Number(value) > 0
const boolean: Check = value => typeof value === 'boolean'
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const one = (...values: readonly unknown[]): Check => value => values.includes(value)
const optional = (check: Check): Check => value => value === undefined || check(value)
const nullable = (check: Check): Check => value => value === null || check(value)
const array = (check: Check): Check => value => Array.isArray(value) && value.every(check)
const fields = (checks: Record<string, Check>): Check => value => object(value)
  && Object.entries(checks).every(([key, check]) => check(value[key]))
const dictionary = (check: Check): Check => value => object(value) && Object.values(value).every(check)
const json: Check = value => value === null || text(value) || boolean(value) || number(value)
  || (Array.isArray(value) ? value.every(json) : object(value) && Object.values(value).every(json))
const timestamp: Check = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))
const money: Check = value => typeof value === 'string' && /^\d+$/.test(value)
const mode = one('off', 'remind', 'auto')
const triggerKind = one('schedule', 'git', 'external', 'window-ended', 'handoff-timeout', 'manual')
const pendingReason = one('approval', 'project-off', 'time-window', 'node-capacity', 'seat-capacity', 'exclusive-tag',
  'budget-full', 'budget-unverifiable', 'provider-unavailable')
const failure = fields({ code: value => typeof value === 'string' && Object.hasOwn(SEAT_ERROR_CODES, value),
  message: text, alternative: text, retryable: boolean, effectState: one('none', 'committed', 'partial', 'unknown') })
const limits = fields({ windowBudgetUsd: optional(money), dailyBudgetUsd: optional(money) })
const budget = fields({ sessionId: id, seat: id, currency: one('USD'), costState: one('known', 'unknown'),
  windowCost: nullable(money), dailyCost: nullable(money), limits, dayKey: text, budgetTimeZone: id,
  inFlightUnknown: integer, watermark: integer, budgetRevision: integer })
const timeout = fields({ messageId: id, senderSessionId: id, deadlineVersion: integer, deadlineAt: timestamp,
  timeoutMinutes: positive, wakeOperationId: id })
const discriminated = (key: string, variants: Record<string, Check>): Check => (value) => {
  if (!object(value) || typeof value[key] !== 'string') return false
  const check = variants[value[key]]
  return check !== undefined && check(value)
}
const evidence = discriminated('kind', {
  schedule: fields({ scheduleId: id, scheduledAt: timestamp }),
  git: fields({ repositoryId: id, ref: id, oldObjectId: nullable(id), newObjectId: nullable(id), observationSequence: integer }),
  external: fields({ eventType: id }),
  'window-ended': fields({ sessionId: id, endedEventId: id, reportId: nullable(id), origin: one('closed', 'can-close') }),
  'handoff-timeout': timeout, manual: fields({ origin: one('manual', 'remote'), operationId: id }),
})
const openingReference = fields({ providerId: id, reference: id, revision: id })
const scopeEvidence = discriminated('status', {
  unknown: fields({ taskId: id, reason: text, alternative: one('serial') }),
  known: fields({ taskId: id, revision: id, repositoryId: id, baseRevision: id,
    entries: array(fields({ kind: one('file', 'directory', 'pattern'), path: id, access: one('read', 'write') })),
    patternSyntax: one('literal', 'glob-v1'), caseSensitive: boolean }),
})
const openingSnapshot = fields({ reference: openingReference, text, digest: id, revision: id,
  taskIds: array(id), scopeEvidence: array(scopeEvidence) })
const taskScope = fields({ taskId: id, seat: id, nodeId: id, scopeEvidence, scopeEvidenceRef: id })
const trigger = fields({ openingContext: optional(openingReference), relatedTaskIds: optional(array(id)),
  triggerId: id, sourceId: id, eventId: optional(id), kind: triggerKind, evidence,
  seat: id, projectId: id, receivedAt: timestamp, dataDigest: id, data: json, taskId: optional(id), callbackRef: id,
  cause: optional(fields({ eventId: id, depth: integer })) })
const frozenOpening = fields({ text, digest: id, variables: fields({ seat: id,
  date: value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value), taskId: nullable(id) }) })
const frozenOpen: Check = value => fields({ recheckRequired: optional(one(true)), definition, title: text,
  openingMode: one('auto', 'prefill'), frozenOpening: optional(frozenOpening), openingContext: optional(openingSnapshot) })(value)
const pending = fields({ frozenOpen: optional(frozenOpen), queueItemId: id, seat: id, projectId: id,
  triggerKind, action: one('open', 'wake-sender', 'replace'),
  replacementId: optional(id), handoffTimeout: optional(timeout), sequence: positive, effectiveMode: mode,
  reason: pendingReason, blockedBy: array(text), sources: array(trigger), relatedTaskIds: array(id),
  queuedAt: timestamp, stateVersion: positive })
const directory = fields({ path: text, startup: boolean })
const seatText = discriminated('kind', { text: fields({ text }), file: fields({ path: id, section: optional(text) }) })
const rule = fields({ id, enabled: boolean, trigger: discriminated('kind', {
  schedule: fields({ selector: dictionary(json), timeZone: id }), git: fields({ repositoryId: id, ref: id }),
  external: fields({ sourceId: id, eventType: optional(text) }), 'window-ended': fields({ seat: id, on: one('closed', 'can-close') }),
  'handoff-timeout': fields({ timeoutMinutes: positive }), manual: fields({ origin: one('manual', 'remote') }),
}), mode: optional(mode), timeWindows: array(fields({ timeZone: id, start: text, end: text, weekdays: optional(array(integer)) })),
exclusiveTags: array(text), windowBudgetUsd: optional(money), dailyBudgetUsd: optional(money), timeoutMinutes: optional(positive),
modelAccountConcurrency: optional(array(fields({ accountLabel: id, limit: positive }))) })
const definition = fields({ schemaVersion: one(1), revision: integer, seat: id, platform: one('desktop', 'vscode', 'server'),
  node: id, projectId: id, directories: array(directory), memoryDirectories: array(text), opening: seatText,
  openingInstructionFiles: array(text), agentPreset: id, provider: id, model: id, reasoningEffort: text,
  permissionPreset: id, subscriptions: array(text),
  checkpointFiles: array(fields({ path: id, section: text, maxBytes: positive, required: boolean })),
  wakeTemplate: optional(seatText), maxOpenSessions: positive, maxActiveSubagents: positive,
  contextThresholdTokens: optional(positive), subagentContextThresholdTokens: positive, rules: array(rule),
  autoKeepAlive: optional(boolean), pollingThreshold: optional(positive), maxSleepSeconds: optional(positive),
  worktree: fields({ clientTreesPerSlot: positive, staleOnSettle: one('notify'), lightByDefault: boolean, staleHours: positive }),
  source: optional(fields({ sourcePath: id, sourceFileHash: id, rowHash: id, mappingHash: id,
    columnHashes: dictionary(id), baseline: dictionary(json), authority: one('import-source', 'seat-store') })),
})
const binding = discriminated('kind', {
  free: fields({ sessionId: id, nodeId: id, identitySource: one('free') }),
  seat: fields({ sessionId: id, seat: id, projectId: id, nodeId: id, bindingSource: one('seat-definition'),
    identitySource: one('settings', 'inherited'), openOperationId: id, seatRevision: integer, taskId: optional(id),
    relatedTaskIds: array(id), directories: array(directory), memoryDirectories: array(text),
    subscriptions: array(text), openingDigest: id }),
})
const open = fields({ definition: optional(definition), sources: optional(array(trigger)), title: optional(text),
  frozenOpening: optional(frozenOpening), openingMode: optional(one('auto', 'prefill')),
  intentId: id, sessionId: id, seatRevision: integer,
  phase: one('intent', 'creating', 'created', 'configuring', 'opening-pending', 'active', 'opening-failed'),
  completedStages: array(one('workspace', 'model', 'permission', 'subscriptions', 'title', 'binding', 'opening')),
  binding, openingOperationId: id, openingMessageId: nullable(id), openingDigest: id, budget, failure: nullable(failure) })
const report = fields({ reportId: id, sessionId: id, canClose: boolean,
  waitingFor: array(fields({ kind: one('subagent', 'job', 'schedule', 'message', 'other'), objectId: optional(id), summary: text })),
  nextOpen: fields({ when: discriminated('kind', { unspecified: fields({}), at: fields({ at: timestamp }),
    condition: fields({ description: text }) }), prerequisites: array(text) }), submittedAt: timestamp, stateVersion: integer })
const endReason = one('manual', 'self-report', 'replaced', 'owner-dead', 'replacement-failed')
const reportStatus = one('submitted', 'not-submitted', 'revoked')
const close = fields({ operationId: optional(id), barrierReleased: optional(boolean), sessionId: id, phase: one('admission', 'rechecking', 'archiving', 'renaming', 'flushing', 'closed'),
  reason: endReason, stateVersion: integer, endedAt: nullable(timestamp), reportId: nullable(id),
  selfReport: nullable(report), selfReportStatus: reportStatus })
const permit = fields({ permitId: id, replacementId: id, oldSessionId: id, newSessionId: id,
  state: one('issued', 'first-turn-running', 'expired-success', 'expired-failure'), issuedAt: timestamp, expiredAt: nullable(timestamp), ownerEpoch: id })
const replacement = fields({ operationId: optional(id), cleanup: optional(one('not-created', 'closed', 'pending')),
  replacementId: id, oldSessionId: id, newSessionId: nullable(id),
  phase: one('queued', 'opening', 'created', 'configuring', 'first-turn-pending', 'awaiting-old-idle', 'closing-old', 'completed', 'closing-new', 'failed'),
  permit: nullable(permit), openingMessageId: nullable(id),
  firstTurn: nullable(fields({ messageId: id, turnId: id, completed: boolean, hasAssistantReply: boolean })),
  pending: nullable(pending), failure: nullable(failure) })
const replacementFailure = one('replacement-open-failed', 'replacement-first-turn-failed', 'replacement-cleanup-failed')
const callbackPayload = fields({ callbackId: id, sourceId: id, triggerId: nullable(id), stateVersion: integer,
  seat: id, title: nullable(text), sessionId: nullable(id), nodeId: id, nodeName: id, budget: limits,
  taskId: optional(id), relatedTaskIds: array(id) })
const callbackKind = discriminated('kind', {
  opened: fields({ sessionId: id, title: text }), 'opening-failed': fields({ reason: failure }),
  'window-ended': fields({ reason: endReason, endedAt: timestamp, selfReport: nullable(report), selfReportStatus: reportStatus, reportId: optional(id) }),
  'budget-stopped': fields({ budgetSnapshot: budget }), rejected: fields({ reason: failure }),
  'replacement-failed': fields({ replacementId: id, oldSessionId: id, newSessionId: nullable(id),
    reason: replacementFailure, cause: failure, cleanup: one('not-created', 'closed', 'pending') }),
})
const modelEvidence = discriminated('status', {
  present: fields({ provider: id, model: id, kind: one('request/header', 'model/selection'),
    sessionId: id, nodeId: id, recordRef: id, observedAt: timestamp }),
  missing: fields({ sessionId: nullable(id), nodeId: id, observedAt: timestamp }),
})
const callback = fields({ payload: value => callbackPayload(value) && callbackKind(value), payloadDigest: id,
  attempt: integer, phase: one('pending', 'retry-due', 'paused', 'delivered'), nextDue: nullable(timestamp),
  nodeWorkChain: optional(fields({ callback: value => callbackPayload(value) && callbackKind(value),
    route: object, modelEvidence, payloadDigest: id })),
  responseClass: nullable(one('success', 'transient', 'authentication', 'protocol', 'unknown')) })
const owner = fields({ sessionId: id, intentId: id, ownerEpoch: id, resourceRevision: positive })
const waitObject = fields({ kind: one('subagent', 'job', 'schedule', 'message'), id })
const observation = fields({ object: waitObject, outcome: one('completed', 'failed', 'cancelled', 'owner-lost', 'unknown'),
  observedAt: timestamp, watermark: integer, durability: one('durable', 'best-effort') })
const wait = fields({ waitId: id, sessionId: id, mode: one('any', 'all'), objects: array(waitObject), observations: array(observation),
  phase: one('registered', 'satisfied', 'woken', 'cancelled'), operationId: id, wakeOperationId: id,
  toolCallId: optional(id), rootCallId: optional(id), stateVersion: integer, durability: one('durable', 'best-effort') })
const child = fields({ ticketId: id, parentSessionId: id, sequence: integer, requestDigest: id, agentPreset: id,
  permissionRevision: integer, activation: optional(json), phase: one('queued', 'admitted', 'released', 'cancelled'), childSessionId: nullable(id), ownerEpoch: id, stateVersion: integer })
const hook = one('before-open', 'before-batch-open', 'before-memory-write', 'before-tool-call',
  'before-subagent-dispatch', 'after-subagent-return', 'after-compaction')
const gate = fields({ id, name: text, hook, criterion: fields({ type: id, parameters: dictionary(json) }),
  alternative: text, expiresAt: nullable(timestamp), enabled: boolean, revision: integer, order: number })
const gateContext = fields({ callId: id, operationId: id, nodeId: id, seat: nullable(id), sessionId: nullable(id), observedAt: timestamp })
const gateHook = discriminated('hook', {
  'before-open': fields({ cwd: text, candidateSeats: array(id) }), 'before-batch-open': fields({ seats: array(id), tasks: optional(array(taskScope)) }),
  'before-memory-write': fields({ targetPath: text, authorizedDirectories: array(text), syntax: one('certain', 'unknown') }),
  'before-tool-call': fields({ toolName: id, arguments: dictionary(json), hasPendingWork: boolean }),
  'before-subagent-dispatch': fields({ parentSessionId: id, kind: one('start', 'continue'), childSessionId: nullable(id), request: dictionary(json) }),
  'after-subagent-return': fields({ parentSessionId: id, childSessionId: id, result: json }),
  'after-compaction': fields({ summary: text, additionalTokenBudget: integer, seatRevision: integer }),
})
const gateResult = fields({ gateId: id, revision: integer, hitCount: integer, expiresAt: nullable(timestamp), audit: one('recorded', 'unavailable') })
const gateOutcome = discriminated('outcome', { allow: fields({}), deny: fields({ reason: failure, alternative: text }),
  observe: fields({ reason: text, alternative: text }) })
const triggerData = fields({ trigger, pending, originalTriggerId: nullable(id),
  deduplication: fields({ key: id, digest: id, receivedAt: timestamp, bucket: nullable(integer), sourceId: id, eventId: nullable(id) }) })
const queueChange = fields({ pending, principalId: id, previousRevision: integer, revision: integer })
const keepalive = fields({ sessionId: id, operationId: id, source: one('auto', 'manual'),
  phase: one('attempted', 'renewed', 'uncertain', 'skipped'), reason: nullable(text), evidenceAt: nullable(number),
  dueAt: nullable(number), observedAt: timestamp })
const checks: Record<EngineEventKind, Check> = {
  'trigger/accepted': triggerData, 'trigger/coalesced': triggerData, 'trigger/deduplicated': triggerData,
  'queue/reminded': fields({ queueItemId: id, seat: id, projectId: id, triggerKind, reason: one('approval'),
    triggerId: id, sequence: positive, stateVersion: positive, remindedAt: timestamp }),
  'queue/pending': pending, 'queue/approved': queueChange, 'queue/cancelled': queueChange,
  'open/intent': open, 'open/created': open, 'open/configured': open, 'open/opening-failed': open,
  'open/rejected': fields({ error: failure, candidates: array(fields({ seat: id, sessionId: id, title: text, nodeId: id })) }),
  'source/rejected': fields({ sourceId: id, sourceEventId: nullable(id), digest: id, error: failure }),
  'seat/binding': binding, 'window/closing': close, 'window/closed': value => close(value) && object(value)
    && value.phase === 'closed' && timestamp(value.endedAt), 'window/replacement': replacement,
  'callback/pending': callback, 'callback/attempted': callback, 'callback/delivered': callback,
  'gate/hit': fields({ definition: gate, context: value => gateContext(value) && gateHook(value),
    result: value => gateResult(value) && gateOutcome(value) }),
  'gate/expired': fields({ definition: gate, hitCount: integer, expiredAt: timestamp }),
  'budget/warning': budget, 'budget/stopped': budget,
  'budget/reconfigured': fields({ budget, previousRevision: integer, authorizationRef: id }),
  'wait/registered': wait, 'wait/satisfied': wait, 'wait/woken': wait, 'wait/cancelled': wait,
  'child/queued': child, 'child/admitted': child, 'child/released': child,
  'job/observed': fields({ sessionId: id, ownerEpoch: id, phase: one('intent', 'running', 'settled'), observation }),
  'resource/reserved': fields({ owner, nodeId: id, seat: id, exclusiveTags: array(text), engineWindowUnits: integer, seatWindowUnits: positive }),
  'resource/released': fields({ owner, reason: one('window-closed', 'holder-death', 'host-restart-recovery', 'open-aborted', 'replacement-handover'),
    observedAt: timestamp, engineReadyAt: nullable(timestamp), releasedAt: timestamp, fenced: one(true) }),
  'mode/changed': fields({ policy: fields({ projectId: id, mode, modeChosen: boolean, revision: integer }),
    previousMode: mode, previousRevision: integer, principalId: id }),
  'memory/audit': fields({ sessionId: id, paths: array(fields({ path: text, before: nullable(id), after: nullable(id) })),
    attribution: one('authorized', 'unauthorized', 'unknown'), complete: boolean, reason: nullable(text) }),
  'report/submitted': fields({ report, principalId: id, toolCallId: optional(id), rootCallId: optional(id) }),
  'report/revoked': fields({ reportId: id, sessionId: id, stateVersion: integer, principalId: id }),
  'cache/keepalive': keepalive, 'cache/keepalive-skipped': keepalive,
  'git/checkpoint': fields({ repositoryId: id, ref: id, objectId: nullable(id), sequence: integer }),
}
/** Validate every required and optional field for a named durable effect.
 * @param kind - decoded event discriminator.
 * @param data - untrusted persisted JSON data.
 * @returns whether the complete payload can be replayed.
 */
export function validEffect(kind: EngineEventKind, data: unknown): boolean {
  if (!checks[kind](data)) return false
  return consistent({ kind, data } as EngineEffect)
}
function consistent(effect: EngineEffect): boolean {
  switch (effect.kind) {
    case 'trigger/accepted': case 'trigger/coalesced': case 'trigger/deduplicated': {
      const { trigger, pending, deduplication } = effect.data
      return trigger.kind === trigger.evidence.kind && trigger.sourceId === deduplication.sourceId
        && (trigger.eventId ?? null) === deduplication.eventId && trigger.seat === pending.seat
        && trigger.projectId === pending.projectId && trigger.kind === pending.triggerKind
    }
    case 'open/intent': case 'open/created': case 'open/configured': case 'open/opening-failed': {
      const data = effect.data
      return data.sessionId === data.binding.sessionId && data.sessionId === data.budget.sessionId
        && (data.binding.kind !== 'seat' || data.binding.seat === data.budget.seat)
        && (effect.kind !== 'open/intent' || data.phase === 'intent')
        && (effect.kind !== 'open/created' || data.phase === 'created')
        && (effect.kind !== 'open/opening-failed' || (data.phase === 'opening-failed' && data.failure !== null))
    }
    case 'queue/reminded': return true
    case 'queue/pending': return pendingConsistent(effect.data)
    case 'queue/approved': case 'queue/cancelled':
      return pendingConsistent(effect.data.pending) && effect.data.revision === effect.data.previousRevision + 1
    case 'window/closing': case 'window/closed': {
      const data = effect.data
      return (effect.kind !== 'window/closed' || (data.phase === 'closed' && data.barrierReleased !== true))
        && (data.barrierReleased !== true || (data.operationId !== undefined && data.endedAt === null
          && ['admission', 'rechecking'].includes(data.phase)))
        && (data.selfReportStatus !== 'submitted' || (data.selfReport !== null && data.reportId === data.selfReport.reportId))
        && (data.selfReport === null || data.selfReport.sessionId === data.sessionId)
    }
    case 'window/replacement': {
      const data = effect.data
      return data.oldSessionId !== data.newSessionId && (data.permit === null || (
        data.permit.replacementId === data.replacementId && data.permit.oldSessionId === data.oldSessionId
        && data.permit.newSessionId === data.newSessionId
        && (data.permit.state.startsWith('expired-') === (data.permit.expiredAt !== null))))
        && (data.phase !== 'queued' || (data.pending !== null && data.newSessionId === null && data.permit === null))
        && (data.firstTurn === null || data.firstTurn.messageId === data.openingMessageId)
    }
    case 'callback/pending': case 'callback/attempted': case 'callback/delivered': {
      const data = effect.data, payload = data.payload
      return (effect.kind !== 'callback/delivered' || (data.phase === 'delivered' && data.responseClass === 'success'))
        && (payload.kind !== 'budget-stopped' || payload.budgetSnapshot.sessionId === payload.sessionId)
        && (payload.kind !== 'window-ended' || payload.selfReport === null || payload.selfReport.sessionId === payload.sessionId)
    }
    case 'gate/hit': return effect.data.definition.id === effect.data.result.gateId
      && effect.data.definition.revision === effect.data.result.revision && effect.data.definition.hook === effect.data.context.hook
    case 'gate/expired': return effect.data.definition.expiresAt !== null
    case 'budget/warning': case 'budget/stopped': return budgetConsistent(effect.data)
    case 'budget/reconfigured': return budgetConsistent(effect.data.budget)
      && effect.data.budget.budgetRevision === effect.data.previousRevision + 1
    case 'wait/registered': case 'wait/satisfied': case 'wait/woken': case 'wait/cancelled':
      return effect.data.phase === effect.kind.slice(5) && effect.data.observations.every(item =>
        effect.data.objects.some(object => object.kind === item.object.kind && object.id === item.object.id))
    case 'child/queued': return effect.data.phase === 'queued' && effect.data.childSessionId === null
    case 'child/admitted': return effect.data.phase === 'admitted' && effect.data.childSessionId !== null
    case 'child/released': return effect.data.phase === 'released' || effect.data.phase === 'cancelled'
    case 'job/observed': return effect.data.phase !== 'settled' || effect.data.observation.outcome !== 'unknown'
    case 'resource/reserved': return effect.data.engineWindowUnits <= effect.data.seatWindowUnits
      && new Set(effect.data.exclusiveTags).size === effect.data.exclusiveTags.length
    case 'resource/released': return Date.parse(effect.data.releasedAt) >= Date.parse(effect.data.observedAt)
      && (effect.data.reason !== 'host-restart-recovery' || effect.data.engineReadyAt !== null)
    case 'mode/changed': return effect.data.policy.revision === effect.data.previousRevision + 1 && effect.data.policy.modeChosen
    case 'memory/audit': return effect.data.complete || effect.data.attribution === 'unknown'
    case 'report/submitted': return effect.data.report.stateVersion > 0
    case 'report/revoked': return effect.data.stateVersion > 0
    case 'cache/keepalive': return effect.data.phase !== 'skipped'
      && (effect.data.phase !== 'renewed' || (effect.data.evidenceAt !== null && effect.data.reason === null))
    case 'cache/keepalive-skipped': return effect.data.phase === 'skipped' && effect.data.reason !== null
    case 'git/checkpoint': return effect.data.ref.startsWith('refs/')
      && (effect.data.objectId === null || /^[a-f0-9]{40,64}$/.test(effect.data.objectId))
    case 'seat/binding': return effect.data.kind === 'free' || effect.data.seatRevision >= 0
    case 'open/rejected': return effect.data.error.effectState === 'none'
    case 'source/rejected': return effect.data.error.effectState === 'none'
    default: { const unreachable: never = effect; return unreachable }
  }
}
function pendingConsistent(data: import('@panedesk/dsh-seat').PendingSeatItem): boolean {
  return (data.action !== 'wake-sender' || data.handoffTimeout !== undefined)
    && (data.action !== 'replace' || data.replacementId !== undefined)
    && data.sources.every(source => source.kind === source.evidence.kind && source.seat === data.seat
      && source.projectId === data.projectId && (data.action === 'replace' || source.kind === data.triggerKind))
}
function budgetConsistent(data: import('@panedesk/dsh-seat').SeatBudgetSnapshot): boolean {
  return data.costState !== 'known' || (data.windowCost !== null && data.dailyCost !== null)
}
