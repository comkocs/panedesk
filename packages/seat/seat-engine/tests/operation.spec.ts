/** Original automatic source operations follow durable local progress without approval. */
import { expect, test } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { queryOperation } from '../src/operation.ts'
import { authorizationFrame, type AuthorizationDecision } from '../src/authorization-storage.ts'
import { fact } from '../src/triggers.ts'
import { harness } from './fixtures.ts'
import { acceptAutomatic } from './operation-fixture.ts'
import { operationHistory, replayOperation, sourceOperation, openingOperation, closingOperation, sessionId } from './operation-fixture.ts'

test('settles a delivered automatic source instead of returning pending configuring with an effect count', async () => {
  const { frames } = await operationHistory()
  expect(frames).toHaveLength(20)
  const view = replayOperation(frames)
  const result = queryOperation(view, { operationId: sourceOperation }, 'node-a')
  expect(result).toMatchObject({ status: 'settled', result: { status: 'opened', phase: 'active', stateVersion: 20 } })
  expect(queryOperation(view, { operationId: openingOperation }, 'node-a')).toEqual(result)
  expect(queryOperation(view, { operationId: closingOperation }, 'node-a')).toMatchObject({ status: 'settled',
    result: { status: 'closed', sessionId, stateVersion: 27 } })
})

test('replays every automatic accepted intent created active and closed stage without approving', async () => {
  const { frames, pending } = await operationHistory()
  expect(frames.flatMap(frame => frame.effects).some(effect => effect.kind === 'queue/approved')).toBe(false)
  for (let count = 1; count <= frames.length; count++) {
    const view = replayOperation(frames, count), restarted = replayOperation(structuredClone(frames), count)
    const result = queryOperation(view, { operationId: sourceOperation }, 'node-a')
    expect(queryOperation(restarted, { operationId: sourceOperation }, 'node-a')).toEqual(result)
    if (count === 1) expect(result).toMatchObject({ status: 'pending', stateVersion: pending.stateVersion })
    else if (count === 12 || count === 13 || count === 18) {
      expect(result).toMatchObject({ status: 'pending', stateVersion: count,
        progress: { blockedBy: ['callback-outcome-unknown'] } })
      expect(queryOperation(view, { operationId: openingOperation }, 'node-a')).toMatchObject({ status: 'settled',
        result: { status: 'opened', stateVersion: count, phase: count === 12 ? 'opening-pending' : 'active' } })
    } else {
      expect(queryOperation(view, { operationId: openingOperation }, 'node-a')).toEqual(result)
      if (count === 2) expect(result).toMatchObject({ status: 'pending', phase: 'intent', stateVersion: count })
      else expect(result).toMatchObject({ status: 'settled', result: { status: 'opened', stateVersion: count,
        phase: count === 3 ? 'created' : count <= 9 ? 'configuring' : count <= 12 ? 'opening-pending' : 'active' } })
    }
  }
})

test('keeps genuine callback unknown ahead of an active or already closed automatic opening', async () => {
  const { frames } = await operationHistory()
  for (const count of [13, 17, 20]) {
    const view = replayOperation(frames, count)
    const callback = [...view.callbacks.values()].at(-1)!
    view.callbacks.set(callback.payload.callbackId, { ...callback, phase: 'pending', responseClass: 'unknown' })
    expect(queryOperation(view, { operationId: sourceOperation }, 'node-a')).toMatchObject({ status: 'pending',
      stateVersion: count, progress: { blockedBy: ['callback-outcome-unknown'] } })
  }
})

test.each(['source', 'trigger', 'node', 'seat', 'project', 'task'] as const)(
  'does not correlate a same-named opening with a different %s', async (mismatch) => {
    const { frames, open } = await operationHistory(), view = replayOperation(frames)
    if (open.binding.kind !== 'seat') throw new Error('Expected seat binding')
    const sources = open.sources!.map(source => ({ ...source,
      ...(mismatch === 'source' ? { sourceId: 'other-source' as T.SeatSourceId } : {}),
      ...(mismatch === 'trigger' ? { triggerId: 'other-trigger' as T.TriggerId } : {}) }))
    const binding = { ...open.binding,
      ...(mismatch === 'node' ? { nodeId: 'other-node' as T.SeatNodeId } : {}),
      ...(mismatch === 'seat' ? { seat: 'other-seat' as T.SeatName } : {}),
      ...(mismatch === 'project' ? { projectId: 'other-project' as T.SeatProjectId } : {}),
      ...(mismatch === 'task' ? { relatedTaskIds: ['other-task' as T.SeatTaskId] } : {}) }
    view.opens.set(sessionId, { ...open, phase: 'active', binding, sources })
    expect(queryOperation(view, { operationId: sourceOperation }, 'node-a')).toEqual({ status: 'pending',
      phase: 'configuring', stateVersion: 20 })
  })

test('selects only the exact source among multiple windows and refuses ambiguous duplicate matches', async () => {
  const { frames, open } = await operationHistory(), view = replayOperation(frames)
  const otherSession = 'other-session' as typeof sessionId
  view.opens.clear()
  view.opens.set(otherSession, { ...open, sessionId: otherSession, sources: open.sources!.map(source => ({ ...source,
    sourceId: 'other-source' as T.SeatSourceId })) })
  view.opens.set(sessionId, { ...open, phase: 'active' })
  expect(queryOperation(view, { operationId: sourceOperation }, 'node-a')).toMatchObject({ status: 'settled',
    result: { status: 'opened', sessionId } })
  view.opens.set(otherSession, { ...open, sessionId: otherSession, phase: 'active' })
  expect(queryOperation(view, { operationId: sourceOperation }, 'node-a')).toMatchObject({ status: 'pending', stateVersion: 20 })
})

test('uses each coalesced original source rather than borrowing another source from its queue snapshot', async () => {
  const { frames } = await operationHistory(), admission = frames[0]!
  const accepted = admission.effects.find(effect => effect.kind === 'trigger/accepted')!
  if (accepted.kind !== 'trigger/accepted') throw new Error('Expected acceptance')
  const otherSource = { ...accepted.data.trigger, triggerId: 'other-trigger' as T.TriggerId,
    sourceId: 'other-source' as T.SeatSourceId }
  const { digest: _digest, byteLength: _byteLength, ...body } = admission
  const changed: AuthorizationDecision[] = [authorizationFrame({ ...body, effects: admission.effects.map((effect) => {
    if (effect.kind === 'trigger/accepted') return { ...effect, kind: 'trigger/coalesced' as const,
      data: { ...effect.data, pending: { ...effect.data.pending, sources: [otherSource, effect.data.trigger] } } }
    return effect
  }) }), ...frames.slice(1)]
  const view = replayOperation(changed), open = view.opens.get(sessionId)!
  view.opens.set(sessionId, { ...open, sources: [otherSource] })
  expect(queryOperation(view, { operationId: sourceOperation }, 'node-a')).toMatchObject({ status: 'pending', stateVersion: 20 })
  view.opens.set(sessionId, { ...open, sources: [otherSource, ...open.sources!] })
  expect(queryOperation(view, { operationId: sourceOperation }, 'node-a')).toMatchObject({ status: 'settled', result: { status: 'opened' } })
})

test('reads automatic execution and the same persisted operation after an engine restart', async () => {
  const h = await harness({ ownerObserveIntervalMs: 60000 })
  try {
    await acceptAutomatic(h)
    await h.engine.drive()
    expect(h.creates).toHaveLength(1)
    expect(queryOperation(h.engine.journal.projection, { operationId: sourceOperation }, 'node-a'))
      .toMatchObject({ status: 'settled', result: { status: 'opened', phase: 'active' } })
    await h.engine.shutdown()
    const before = queryOperation(h.engine.journal.projection, { operationId: sourceOperation }, 'node-a')
    const restarted = await h.start()
    expect(queryOperation(restarted.journal.projection, { operationId: sourceOperation }, 'node-a')).toEqual(before)
    expect(h.creates).toHaveLength(1)
  } finally { await h.close() }
})

test('uses the committed cursor for an owned non-opening fallback, not the number of owned effects', async () => {
  const { frames } = await operationHistory(), view = replayOperation(frames)
  const operationId = 'fallback-operation' as T.SeatOperationId
  view.decisions.push({ ...view.decisions[0]!, effects: [fact({ kind: 'queue/pending', operationId,
    data: [...replayOperation(frames, 1).pending.values()][0]! })] })
  expect(queryOperation(view, { operationId }, 'node-a')).toEqual({ status: 'pending', phase: 'configuring', stateVersion: 20 })
  expect(queryOperation(view, { operationId: 'missing-operation' as T.SeatOperationId }, 'node-a')).toEqual({ status: 'missing' })
})
