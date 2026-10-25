/** Fixed local ingress preserves legacy results, source digests and fact vocabulary. */
import { afterEach, expect, test, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { harness, seat, trigger } from './fixtures.ts'
import { digest } from '../src/journal.ts'

vi.mock('node:crypto', async original => ({ ...await original<typeof import('node:crypto')>(),
  randomUUID: () => '00000000-0000-4000-8000-000000000001' }))
afterEach(() => vi.useRealTimers())

test.each(['registry', 'node-link', 'both'] as const)(
  'keeps local acceptance and remote refusal byte-identical with missing %s', async (missing) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const expected = JSON.parse(
      await readFile(new URL('./default-results.json', import.meta.url), 'utf8')) as { accepted: string; rejected: string }
    const h = await harness()
    try {
      const registry = { register: vi.fn(() => () => {}), resolve: vi.fn(() => undefined), ready: async () => {} }
      if (missing === 'node-link') h.ctx.provide('nodeWorkChainBusiness', registry)
      if (missing === 'registry') h.ctx.provide('nodeWorkChain', { maxControlPending: 2,
        local: { methods: [], ready: () => Promise.resolve() },
        policy: { expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 1000 }, ready: () => Promise.resolve(),
          authorize: async () => { throw new Error('Missing registration cannot authorize chain calls') } } })
      expect(Boolean(h.ctx.get('nodeWorkChainBusiness'))).toBe(missing === 'node-link')
      expect(Boolean(h.ctx.get('nodeWorkChain'))).toBe(missing === 'registry')
      for (const method of ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'] as const) {
        expect(h.ctx.get('nodeWorkChainBusiness')?.resolve(method)).toBeUndefined()
      }
      expect(registry.register).not.toHaveBeenCalled()
      expect(h.ctx.get('nodeRouter')).toBeUndefined()
      const result = await h.engine.accept(trigger())
      expect(JSON.stringify(result)).toBe(expected.accepted)
      const effects = h.engine.journal.projection.decisions.flatMap(decision => decision.effects)
      expect(effects.map(effect => effect.kind)).toEqual(['trigger/accepted', 'queue/reminded'])
      const accepted = effects[0]
      if (accepted?.kind !== 'trigger/accepted') throw new Error('Missing accepted fact')
      expect(accepted.data.trigger).toEqual({ ...trigger(), receivedAt: '2026-01-01T00:00:00.000Z' })
      expect(accepted.data.deduplication).toEqual({ key: '["source-a","event-a",null]',
        digest: digest({ kind: 'external', evidence: { kind: 'external', eventType: 'event-a' }, seat,
          projectId: 'project-a', data: null, callbackRef: 'source-a' }),
        receivedAt: '2026-01-01T00:00:00.000Z', bucket: null, sourceId: 'source-a', eventId: 'event-a' })
      expect(accepted.data.pending.frozenOpen).toEqual({ definition: h.definitions.get(seat), title: 'seat-a 01-01', openingMode: 'auto' })
      expect(h.engine.journal.projection.authorizationDecisions[0]?.requiredCapabilities).toBeUndefined()
      h.definitions.get(seat)!.node = 'remote'
      const refusal = { status: 'rejected', error: { code: 'cross-node-unsupported', message: 'The seat belongs to another node',
        alternative: 'Inspect engine state and retry with the same operation identity.', retryable: false, effectState: 'none' } }
      expect(JSON.stringify(await h.engine.accept(trigger('external', 'remote-event')))).toBe(expected.rejected)
      expect(h.engine.journal.projection.decisions.at(-1)?.effects).toEqual([{
        kind: 'source/rejected', seat, eventId: '00000000-0000-4000-8000-000000000001', data: {
          sourceId: 'source-a', sourceEventId: 'remote-event', digest: digest(null), error: refusal.error },
      }])
      expect(h.engine.journal.projection.resources.size).toBe(0)
      expect(h.creates).toEqual([])
      const names = await readdir(h.home, { recursive: true })
      expect(names.filter(name => /(^|[/\\])(?:chain-received|chain-sent|chain-evidence|chain-v1\.json)(?:$|[/\\])/.test(name))).toEqual([])
    } finally { await h.close() }
  })
