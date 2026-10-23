/** Persisted examples cover every engine event discriminator without runtime providers. */
import { SEAT_ENGINE_EVENT_NAMES, type EngineEventKind } from '@panedesk/dsh-seat'
import { budget, definition, nodeId, projectId, seat, trigger } from './fixtures.ts'
import { digest } from '../src/journal.ts'

const at = '2026-01-01T00:00:00.000Z'
const error = { code: 'invalid-request', message: 'Invalid input', alternative: 'Inspect input', retryable: false, effectState: 'none' }
const source = trigger()
const pending = { queueItemId: 'queue-a', seat, projectId, triggerKind: 'external', action: 'open', sequence: 1,
  effectiveMode: 'auto', reason: 'provider-unavailable', blockedBy: [], sources: [source], relatedTaskIds: [], queuedAt: at, stateVersion: 1 }
const binding = { kind: 'seat', sessionId: 'window-a', seat, projectId, nodeId, bindingSource: 'seat-definition',
  identitySource: 'settings', openOperationId: 'operation-a', seatRevision: 1, relatedTaskIds: [],
  directories: [], memoryDirectories: [], subscriptions: [], openingDigest: 'digest-a' }
const open = { definition: definition(), sources: [source], title: 'window-a', intentId: 'intent-a', sessionId: 'window-a',
  seatRevision: 1, phase: 'intent', completedStages: [], binding, openingOperationId: 'operation-a', openingMessageId: null,
  openingDigest: 'digest-a', budget: budget(), failure: null }
const report = { reportId: 'report-a', sessionId: 'window-a', canClose: true, waitingFor: [],
  nextOpen: { when: { kind: 'unspecified' }, prerequisites: [] }, submittedAt: at, stateVersion: 1 }
const close = { sessionId: 'window-a', phase: 'closed', reason: 'manual', stateVersion: 1,
  endedAt: at, reportId: report.reportId, selfReport: report, selfReportStatus: 'submitted' }
const payload = { kind: 'opened', callbackId: 'callback-a', sourceId: 'source-a', triggerId: 'event-a',
  stateVersion: 1, seat, title: 'window-a', sessionId: 'window-a', nodeId, nodeName: 'node-a', budget: {}, relatedTaskIds: [] }
const callback = { payload, payloadDigest: digest(payload), attempt: 0, phase: 'pending', nextDue: null, responseClass: null }
const gate = { id: 'gate-a', name: 'gate-a', hook: 'before-open', criterion: { type: 'criterion-a', parameters: {} },
  alternative: 'Inspect the workspace', expiresAt: at, enabled: true, revision: 1, order: 0 }
const wait = { waitId: 'wait-a', sessionId: 'window-a', mode: 'all', objects: [{ kind: 'job', id: 'job-a' }], observations: [],
  phase: 'registered', operationId: 'wait-operation', wakeOperationId: 'wake-operation', stateVersion: 1, durability: 'durable' }
const child = { ticketId: 'ticket-a', parentSessionId: 'window-a', sequence: 1, requestDigest: 'digest-a', agentPreset: 'agent-a',
  permissionRevision: 1, phase: 'queued', childSessionId: null, ownerEpoch: 'epoch-a', stateVersion: 1 }
const owner = { sessionId: 'window-a', intentId: 'intent-a', ownerEpoch: 'epoch-a', resourceRevision: 1 }
const triggerData = { trigger: source, pending, originalTriggerId: null, deduplication: { key: 'key-a', digest: 'digest-a',
  receivedAt: at, bucket: null, sourceId: source.sourceId, eventId: source.eventId } }
const keepalive = { sessionId: 'window-a', operationId: 'operation-a', source: 'auto', phase: 'renewed', reason: null,
  evidenceAt: 1, dueAt: 2, observedAt: at }
export const examples: Record<EngineEventKind, Record<string, unknown>> = {
  'trigger/accepted': triggerData, 'trigger/coalesced': triggerData, 'trigger/deduplicated': triggerData,
  'queue/reminded': { queueItemId: pending.queueItemId, seat, projectId, triggerKind: 'external', reason: 'approval',
    triggerId: source.triggerId, sequence: 1, stateVersion: 1, remindedAt: at },
  'queue/pending': pending,
  'queue/approved': { pending, principalId: 'principal-a', previousRevision: 0, revision: 1 },
  'queue/cancelled': { pending, principalId: 'principal-a', previousRevision: 0, revision: 1 },
  'open/intent': open, 'open/created': { ...open, phase: 'created' },
  'open/configured': { ...open, phase: 'configuring' }, 'open/opening-failed': { ...open, phase: 'opening-failed', failure: error },
  'open/rejected': { error, candidates: [] },
  'source/rejected': { sourceId: 'source-a', sourceEventId: null, digest: 'digest-a', error },
  'seat/binding': binding, 'window/closing': { ...close, phase: 'flushing' }, 'window/closed': close,
  'window/replacement': { replacementId: 'replace-a', operationId: 'operation-a', oldSessionId: 'window-a',
    newSessionId: 'window-b', phase: 'opening', permit: { permitId: 'permit-a', replacementId: 'replace-a',
      oldSessionId: 'window-a', newSessionId: 'window-b', state: 'issued', issuedAt: at, expiredAt: null, ownerEpoch: 'epoch-a' },
    openingMessageId: null, firstTurn: null, pending: null, failure: null },
  'callback/pending': callback, 'callback/attempted': { ...callback, attempt: 1 },
  'callback/delivered': { ...callback, phase: 'delivered', responseClass: 'success' },
  'gate/hit': { definition: gate, context: { callId: 'call-a', operationId: 'operation-a', nodeId, seat,
    sessionId: 'window-a', observedAt: at, hook: 'before-open', cwd: '/workspace', candidateSeats: [] },
  result: { gateId: 'gate-a', revision: 1, hitCount: 1, expiresAt: at, audit: 'recorded', outcome: 'allow' } },
  'gate/expired': { definition: gate, hitCount: 1, expiredAt: at },
  'budget/warning': { ...budget() }, 'budget/stopped': { ...budget() },
  'budget/reconfigured': { budget: { ...budget(), budgetRevision: 1 }, previousRevision: 0, authorizationRef: 'auth-a' },
  'wait/registered': wait, 'wait/satisfied': { ...wait, phase: 'satisfied' },
  'wait/woken': { ...wait, phase: 'woken' }, 'wait/cancelled': { ...wait, phase: 'cancelled' },
  'child/queued': child, 'child/admitted': { ...child, phase: 'admitted', childSessionId: 'child-a' },
  'child/released': { ...child, phase: 'released' },
  'job/observed': { sessionId: 'window-a', ownerEpoch: 'epoch-a', phase: 'settled', observation: {
    object: { kind: 'job', id: 'job-a' }, outcome: 'completed', observedAt: at, watermark: 1, durability: 'durable' } },
  'resource/reserved': { owner, nodeId, seat, exclusiveTags: ['tag-a'], engineWindowUnits: 1, seatWindowUnits: 1 },
  'resource/released': { owner, reason: 'window-closed', observedAt: at, engineReadyAt: null, releasedAt: at, fenced: true },
  'mode/changed': { policy: { projectId, mode: 'auto', modeChosen: true, revision: 1 },
    previousMode: 'remind', previousRevision: 0, principalId: 'principal-a' },
  'memory/audit': { sessionId: 'window-a', paths: [], attribution: 'authorized', complete: true, reason: null },
  'report/submitted': { report, principalId: 'principal-a' },
  'report/revoked': { reportId: 'report-a', sessionId: 'window-a', stateVersion: 1, principalId: 'principal-a' },
  'cache/keepalive': keepalive, 'cache/keepalive-skipped': { ...keepalive, phase: 'skipped', reason: 'missed-due' },
  'git/checkpoint': { repositoryId: 'repo-a', ref: 'refs/heads/main', objectId: 'a'.repeat(40), sequence: 1 },
}
export const eventKinds = Object.keys(SEAT_ENGINE_EVENT_NAMES) as EngineEventKind[]
