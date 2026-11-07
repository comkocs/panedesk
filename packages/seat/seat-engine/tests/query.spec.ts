import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { auto, harness, seat, trigger } from './fixtures.ts'
import { queryEngine } from '../src/query.ts'
import { queryTasks } from '../src/task-query.ts'
import { fact } from '../src/triggers.ts'
import { digest } from '../src/journal.ts'
import type * as T from '@panedesk/dsh-seat'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
it('queries callback failure stages by task and seat with bounded pagination', async () => {
  const h = await harness(); cleanups.push(h.close)
  const taskId = 'task-a' as T.SeatTaskId
  const payload: T.SeatCallbackPayload = { kind: 'opened', callbackId: 'callback-a' as T.CallbackId, sourceId: 'source-a' as T.SeatSourceId,
    triggerId: null, seat, sessionId: 'session-a' as NonNullable<T.SeatCallbackPayload['sessionId']>, title: 'Window',
    nodeId: h.engine.options.nodeId, nodeName: 'node-a', stateVersion: 1, budget: {}, relatedTaskIds: [taskId] }
  const diagnostic: T.SeatCallbackDiagnostic = { stage: 'local-query', cause: { domain: 'seat-callback', code: 'unavailable',
    reason: 'Owner is unavailable', effectState: 'none', retryable: true, operationId: 'operation-a' as T.SeatOperationId,
    nodeId: payload.nodeId, reasonCode: 'hello-policy-not-ready' } }
  const delivery: T.SeatCallbackDelivery = { payload, payloadDigest: digest(payload), attempt: 1, phase: 'retry-due',
    nextDue: '2026-01-01T00:00:00Z', responseClass: 'transient', lastDiagnostic: diagnostic }
  await h.engine.journal.commit(() => [fact({ kind: 'callback/attempted', data: delivery })])
  const { lastDiagnostic: _diagnostic, ...withoutDiagnostic } = delivery
  await h.engine.journal.commit(() => [fact({ kind: 'callback/delivered', data: { ...withoutDiagnostic, phase: 'delivered',
    responseClass: 'success', nextDue: null, attempt: 2 } })])
  const decisions = h.engine.journal.projection.decisions
  const request = { nodeId: payload.nodeId, seat, taskId, kinds: ['callback/attempted', 'callback/delivered'] as const, limit: 1 }
  const first = queryTasks(decisions, request)
  expect(first.effects).toHaveLength(1)
  expect(first.effects[0]).toMatchObject({ kind: 'callback/attempted', data: delivery })
  expect(first.complete).toBe(false)
  const second = queryTasks(decisions, { ...request, cursor: first.nextCursor! })
  expect(second.effects).toHaveLength(1)
  expect(second.effects[0]?.kind).toBe('callback/delivered')
  expect(second.complete).toBe(true)
  expect(queryTasks(decisions, { ...request, taskId: 'unrelated' as T.SeatTaskId }).effects).toEqual([])
  expect(queryTasks(decisions, { ...request, seat: 'other' as T.SeatName }).effects).toEqual([])
  const primary = { ...payload, callbackId: 'callback-b' as T.CallbackId, relatedTaskIds: [], taskId }
  await h.engine.journal.commit(() => [fact({ kind: 'callback/attempted', data: { ...delivery, payload: primary, payloadDigest: digest(primary) } })])
  expect(queryTasks(h.engine.journal.projection.decisions, { ...request, limit: 10 }).effects).toHaveLength(3)
})

it('A24 advances filtered cursors and exports verified independent engine frames', async () => {
  const h = await harness(); cleanups.push(h.close); await auto(h.engine)
  await h.engine.accept({ ...trigger(), data: { text: 'private source text' } }); await h.engine.drive()
  const decisions = h.engine.journal.projection.decisions
  const all = queryEngine(decisions, { seat, limit: 100 }).effects
  const collected = []
  let cursor: import('@panedesk/dsh-seat').EngineCursor | undefined
  for (;;) {
    const page = await h.engine.query({ seat, limit: 1, ...(cursor ? { cursor } : {}) })
    collected.push(...page.effects); cursor = page.nextCursor
    if (page.complete) break
  }
  expect(collected).toEqual(all)
  const output = join(h.home, 'export.jsonl')
  expect(await h.engine.export({ query: { limit: 1000 }, format: 'jsonl', output })).toMatchObject({ status: 'exported' })
  expect(await readFile(output, 'utf8')).not.toContain('private source text')
  expect(await h.engine.verify({ input: output })).toMatchObject({ status: 'verified', tail: 'complete' })
  expect(await readdir(join(h.home, 'ledger'))).toEqual(['engine'])
  expect(decisions.every(d => d.namespace === 'ledger/engine/v1' && d.schemaVersion === 1)).toBe(true)
})
it('A24 rejects foreign cursors without executing imported state', async () => {
  const h = await harness(); cleanups.push(h.close); await auto(h.engine)
  await expect(h.engine.query({ cursor: { nodeId: 'foreign' as never, sequence: 1, effectIndex: 0 }, limit: 1 })).rejects.toThrow('Cursor')
  expect(h.creates).toEqual([])
})
