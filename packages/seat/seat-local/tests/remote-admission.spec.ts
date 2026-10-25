/** Optional remote policies preserve legacy catalog values and local-only resolution. */
import { expect, test } from 'vitest'
import { parseDefinition, resolveSeat } from '../src/schema.ts'
import { digest } from '../src/store.ts'
import { catalogs, definition } from './fixtures.ts'

const policy = { allowOpen: true, sourceNodeIds: ['source-node'], sourceIds: ['source'], principalIds: ['principal'],
  methods: ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'], policyRevision: 1 }

test('keeps the absent policy and legacy definition digest byte-identical', async () => {
  const original = definition('/workspace')
  expect(parseDefinition(original)).toEqual(original)
  const { rules, ...legacyOrder } = original
  expect(JSON.stringify(parseDefinition(original))).toBe(JSON.stringify({ ...legacyOrder, rules }))
  expect(digest(parseDefinition(original))).toBe(digest(original))
  expect(parseDefinition(original)).not.toHaveProperty('remoteAdmission')
  expect(await resolveSeat(original, catalogs('/workspace'))).toEqual(original)
  expect(await resolveSeat({ ...original, node: 'remote' }, catalogs('/workspace'))).toEqual({
    status: 'rejected', error: { code: 'cross-node-unsupported', message: 'The definition does not belong to this node.',
      alternative: 'Run the operation on its configured node.', retryable: false, effectState: 'none' },
  })
})

test('retains explicit remote permissions without relaxing local resolution', async () => {
  const parsed = parseDefinition({ ...definition('/workspace'), remoteAdmission: policy })
  expect(parsed).toEqual({ ...definition('/workspace'), remoteAdmission: policy })
  if ('status' in parsed) throw new Error('Expected a parsed definition')
  expect(await resolveSeat({ ...parsed, node: 'remote' }, catalogs('/workspace'))).toMatchObject({
    status: 'rejected', error: { code: 'cross-node-unsupported' },
  })
})

test.each([
  { allowOpen: false }, { sourceNodeIds: [] }, { sourceIds: [] }, { principalIds: [] }, { methods: [] },
  { sourceNodeIds: ['*'] }, { sourceIds: ['all'] }, { principalIds: ['principal', 'principal'] },
  { sourceNodeIds: ['node?'] }, { sourceIds: ['source\n'] }, { principalIds: [' '] },
  { methods: ['seat.renew'] }, { methods: ['seat.openFrozen', 'seat.openFrozen'] },
  { policyRevision: 0 }, { policyRevision: 1.5 },
])('rejects invalid explicit remote permissions: %j', (invalid) => {
  expect(parseDefinition({ ...definition('/workspace'), remoteAdmission: { ...policy, ...invalid } }))
    .toMatchObject({ status: 'rejected', error: { code: 'invalid-definition' } })
})
