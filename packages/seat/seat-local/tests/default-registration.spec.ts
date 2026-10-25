/** Ordinary Loader composition owns no chain registration or chain persistence. */
import { expect, test } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { ChainBusinessRegistry } from '@panedesk/dsh-node-link/src/chain-business.ts'

test.each(['registry', 'node-link', 'both'] as const)(
  'keeps default replies byte-identical with missing %s and no chain registration or storage after Loader reload', async (missing) => {
    const expected = JSON.parse(
      await readFile(new URL('./default-results.json', import.meta.url), 'utf8')) as { cancelled: string; saved: string; missing: string }
    const h = await admissionHost()
    try {
      const registry = new ChainBusinessRegistry()
      if (missing === 'node-link') h.ctx.provide('nodeWorkChainBusiness', registry)
      if (missing === 'registry') h.ctx.provide('nodeWorkChain', { maxControlPending: 2,
        local: { methods: [], ready: () => Promise.resolve() },
        policy: { expiry: { maxLifetimeMs: 60000, maxClockSkewMs: 1000 }, ready: () => Promise.resolve(),
          authorize: async () => { throw new Error('Missing registration cannot authorize chain calls') } } })
      await h.ctx.loader.await()
      const check = async () => {
        expect(Boolean(h.ctx.get('nodeWorkChainBusiness'))).toBe(missing === 'node-link')
        expect(Boolean(h.ctx.get('nodeWorkChain'))).toBe(missing === 'registry')
        for (const method of ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'] as const) {
          expect(registry.resolve(method)).toBeUndefined()
        }
        expect(h.ctx.get('nodeWorkChainRouter')).toBeUndefined()
        expect(h.ctx.get('nodeRouter')).toBeUndefined()
        const seats = h.ctx.get('seats')!.withAuthority(h.authority)
        expect(JSON.stringify(await seats.save({ definition: h.definition, expectedRevision: 2,
          operationId: 'default-save' as T.SeatOperationId }))).toBe(expected.saved)
        expect(JSON.stringify(await seats.open({ seat: h.definition.seat, origin: 'manual',
          operationId: 'default-cancel' as T.SeatOperationId, existingChoice: { kind: 'cancel' } }))).toBe(expected.cancelled)
        expect(JSON.stringify(await seats.open({ seat: 'missing-seat' as T.SeatName, origin: 'manual',
          operationId: 'default-missing' as T.SeatOperationId }))).toBe(expected.missing)
        const names = await readdir(h.options.directory, { recursive: true })
        const chainStorage = /(^|[/\\])(?:chain-received|chain-sent|chain-evidence|chain-v1\.json)(?:$|[/\\])/
        expect(names.filter(name => chainStorage.test(name))).toEqual([])
        expect(h.engine.journal.projection.authorizationDecisions.some(frame => frame.requiredCapabilities !== undefined)).toBe(false)
        expect(h.adapter.requests).toHaveLength(0)
      }
      await check()
      await h.reload()
      await check()
    } finally { await h.close() }
  })
