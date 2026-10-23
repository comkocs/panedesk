import { expect, it } from 'vitest'
import type { EngineDecision, EngineEffect, EngineEventKind, EngineDecisionId, SeatNodeId } from '@panedesk/dsh-seat'
import { canonical, decodeFrame, frame } from '../src/journal.ts'
import { examples, eventKinds } from './validation-fixtures.ts'

function encoded(kind: EngineEventKind, data: Record<string, unknown>, duplicate = false) {
  const effect = { eventId: 'event-a', kind, data } as EngineEffect
  const input = { namespace: 'ledger/engine/v1', schemaVersion: 1, decisionId: 'decision-a' as EngineDecisionId, sequence: 1,
    nodeId: 'node-a' as SeatNodeId, observedAt: '2026-01-01T00:00:00.000Z', policyRevision: 0,
    effects: duplicate ? [effect, effect] : [effect] } as Omit<EngineDecision, 'digest' | 'byteLength'>
  return canonical(frame(input))
}
const optional = new Set(['definition', 'sources', 'title', 'operationId', 'cleanup', 'replacementId', 'handoffTimeout'])
it.each(eventKinds)('validates every persisted %s field before replay', (kind) => {
  const sample = examples[kind]
  expect(() => decodeFrame(encoded(kind, sample), 200000)).not.toThrow()
  for (const key of Object.keys(sample)) {
    const missing = Object.fromEntries(Object.entries(sample).filter(([field]) => field !== key))
    if (!optional.has(key) || kind === 'window/replacement' && key === 'replacementId') {
      expect(() => decodeFrame(encoded(kind, missing), 200000), `${kind}.${key} missing`).toThrow(/Invalid engine effect/)
    }
    const invalid = structuredClone(sample); invalid[key] = typeof sample[key] === 'object' ? false : { invalidField: true }
    expect(() => decodeFrame(encoded(kind, invalid), 200000), `${kind}.${key} type`).toThrow(/Invalid engine effect/)
  }
  expect(() => decodeFrame(encoded(kind, sample, true), 200000)).toThrow('Duplicate engine event identity')
})
it.each(eventKinds)('rejects cross-field identity conflicts in %s frames', (kind) => {
  const input: unknown = JSON.parse(encoded(kind, examples[kind]))
  if (!input || typeof input !== 'object' || !('effects' in input) || !Array.isArray(input.effects)) throw new Error('Missing frame')
  const frameData = input as EngineDecision
  const first = frameData.effects[0]
  if (!first) throw new Error('Missing effect')
  const data = first.data as Record<string, unknown>
  let field = ['sessionId', 'seat', 'operationId'].find(key => typeof data[key] === 'string')
  if (!field) field = 'sessionId'
  const effect = { ...first, [field]: 'conflicting-a',
    data: { ...data, [field]: data[field] ?? 'original-a' } } as EngineEffect
  const { digest: _digest, byteLength: _byteLength, ...semantic } = frameData
  expect(() => decodeFrame(canonical(frame({ ...semantic, effects: [effect] })), 200000)).toThrow(/Inconsistent engine effect/)
})
it.each([
  ['open/intent', 'binding', { ...examples['seat/binding'], sessionId: 'other-a' }],
  ['trigger/accepted', 'deduplication', { ...(examples['trigger/accepted'].deduplication as object), sourceId: 'other-a' }],
  ['window/replacement', 'permit', { ...(examples['window/replacement'].permit as object), replacementId: 'other-a' }],
  ['budget/reconfigured', 'previousRevision', 9],
  ['resource/reserved', 'engineWindowUnits', 2],
  ['callback/pending', 'payloadDigest', 'wrong-digest'],
] as const)('rejects inconsistent %s.%s with a decoder reason', (kind, field, value) => {
  expect(() => decodeFrame(encoded(kind, { ...examples[kind], [field]: value }), 200000)).toThrow(/engine effect/)
})
