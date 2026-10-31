/** Human approval absorption is atomic with acceptance and rejects stale or unrelated queues. */
import { expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { digest } from '../src/journal.ts'
import { definition, harness, nodeId, seat, trigger } from './fixtures.ts'

it.each(['local', 'verified-remote', 'other-ticket', 'stale', 'revoked'] as const)('absorbs only the authorized approval: %s', async (scenario) => {
  const h = await harness()
  const taskId = 'task-a' as T.SeatTaskId
  try {
    await h.engine.accept({ ...trigger(), taskId, relatedTaskIds: [taskId] })
    const pending = [...h.engine.journal.projection.pending.values()][0]
    if (!pending) throw new Error('Expected approval')
    h.engine.registerSource({ sourceId: 'seat-local-manual' as T.SeatSourceId, kinds: ['manual'],
      maxRedeliveryMs: null, callback: async () => {} })
    const selectedTask = scenario === 'other-ticket' ? 'task-b' as T.SeatTaskId : taskId
    const request: T.OpenSeatRequest = { seat, origin: 'manual', operationId: 'human-open' as T.SeatOperationId,
      taskId: selectedTask, openingMode: 'prefill' }
    const principalId = 'verified-human' as T.SeatPrincipalId
    const registered = h.engine.authorizationIssuers.register({ identity: { kind: 'human', principalId, nodeId,
      origin: scenario === 'verified-remote' ? 'remote' : 'manual', seat, taskIds: [selectedTask], policyRevision: 1 },
    current: () => ({ decision: 'allowed', reasonCode: 'verified-human', policyRevision: 1 }) })
    try {
      const grant = await registered.issuer.check({ operationId: request.operationId, requestDigest: digest(request) })
      if ('status' in grant) throw new Error('Expected grant')
      if (scenario === 'revoked') registered.dispose()
      const input: T.SeatLocalOpenRequest = { request, authority: { principalId, nodeId, origin: 'manual', authorization: grant },
        definition: definition(), title: 'Human window', opening: { text: 'Opening', digest: digest('Opening'),
          variables: { seat, date: '2026-01-01', taskId: selectedTask } } }
      const result = await h.engine.withApprovalAbsorption(grant,
        [{ queueItemId: pending.queueItemId, stateVersion: pending.stateVersion + Number(scenario === 'stale') }],
        () => h.engine.openWindow(input))
      if (scenario === 'local' || scenario === 'verified-remote') {
        expect(result.status).toBe('prefilled')
        const frame = h.engine.journal.projection.decisions.find(row => row.effects.some(effect => effect.kind === 'queue/cancelled'))
        expect(frame?.effects.map(effect => effect.kind)).toEqual(['queue/cancelled', 'trigger/accepted'])
        expect(h.engine.journal.projection.pending.has(pending.queueItemId)).toBe(false)
        expect(h.creates).toHaveLength(1)
        expect(h.callbacks.some(callback => callback.kind === 'rejected')).toBe(false)
        const replay = await h.engine.withApprovalAbsorption(grant, [pending], () => h.engine.openWindow(input))
        expect(replay).toMatchObject({ status: result.status, ...('sessionId' in result ? { sessionId: result.sessionId } : {}) })
        expect(h.creates).toHaveLength(1)
        expect(h.engine.journal.projection.decisions.flatMap(row => row.effects)
          .filter(effect => effect.kind === 'queue/cancelled' && effect.operationId === request.operationId)).toHaveLength(1)
        expect(h.callbacks.some(callback => callback.kind === 'rejected')).toBe(false)
      } else {
        expect(result.status).toBe('rejected')
        expect(h.engine.journal.projection.pending.has(pending.queueItemId)).toBe(true)
        expect(h.creates).toHaveLength(0)
        expect(h.engine.journal.projection.decisions.flatMap(row => row.effects).some(effect => effect.kind === 'queue/cancelled')).toBe(false)
      }
    } finally { registered.dispose() }
  } finally { await h.close() }
})
