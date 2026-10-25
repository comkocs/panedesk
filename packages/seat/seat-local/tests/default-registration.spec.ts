/** Ordinary Loader composition owns no chain registration or chain persistence. */
import { expect, test } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'

test('keeps default replies byte-identical without a registry, node-link or chain storage after Loader reload', async () => {
  const expected = JSON.parse(
    await readFile(new URL('./default-results.json', import.meta.url), 'utf8')) as { cancelled: string; missing: string }
  const h = await admissionHost()
  try {
    const check = async () => {
      expect(h.ctx.get('nodeWorkChainBusiness')).toBeUndefined()
      expect(h.ctx.get('nodeWorkChain')).toBeUndefined()
      expect(h.ctx.get('nodeWorkChainRouter')).toBeUndefined()
      expect(h.ctx.get('nodeRouter')).toBeUndefined()
      const seats = h.ctx.get('seats')!.withAuthority(h.authority)
      expect(JSON.stringify(await seats.open({ seat: h.definition.seat, origin: 'manual',
        operationId: 'default-cancel' as T.SeatOperationId, existingChoice: { kind: 'cancel' } }))).toBe(expected.cancelled)
      expect(JSON.stringify(await seats.open({ seat: 'missing-seat' as T.SeatName, origin: 'manual',
        operationId: 'default-missing' as T.SeatOperationId }))).toBe(expected.missing)
      const names = await readdir(h.options.directory, { recursive: true })
      expect(names.filter(name => /(^|[/\\])(?:chain-received|chain-sent|chain-evidence|chain-v1\.json)(?:$|[/\\])/.test(name))).toEqual([])
      expect(h.engine.journal.projection.authorizationDecisions.some(frame => frame.requiredCapabilities !== undefined)).toBe(false)
      expect(h.adapter.requests).toHaveLength(0)
    }
    await check()
    await h.reload()
    await check()
  } finally { await h.close() }
})
