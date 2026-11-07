/** Loader-owned profile providers retain the caller identity of each Remote service view. */
import { expect, it } from 'vitest'
import type { PeerId, RemoteInvocation } from '@panedesk/dsh-typert-protocol'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Profiles from '../src/index.ts'
import SeatUi from '@panedesk/dsh-client-ui-seats'
import { admissionHost } from '../../../seat/seat-local/tests/admission-host.ts'

it('propagates owner invocation through profile reads, dashboard and mapped import previews', async () => {
  const f = await admissionHost()
  try {
    Object.assign(f.ctx.loader.builtins, { profiles: Profiles, seatUi: SeatUi })
    await f.load('profile-invocation.yml', [{ name: 'cordis:profiles' }, { name: 'cordis:seatUi' }])
    const controller = new AbortController()
    const invocation: RemoteInvocation = {
      request: { namespace: 'seatProfiles', method: 'read', args: {} }, service: 'seatProfiles',
      peer: { id: 'profile-owner' as PeerId, ctx: f.ctx, principal: { kind: 'owner' },
        signal: controller.signal, interactions: 'none', dispose: async () => {} },
      signal: controller.signal,
      uplink: async function* () {},
    }
    const caller = f.ctx.extend({ invocation })
    const profiles = caller.get('seatProfiles')
    const dashboard: unknown = caller.get('seatUi')
    const access = caller.get('seatProfilesLocal')
    if (!profiles || !(dashboard instanceof SeatUi) || !access) throw new Error('Profile providers did not load')
    expect(f.ctx.invocation).toBeUndefined()
    expect((await profiles.read()).definitions).toEqual([f.definition])
    expect((await dashboard.dashboard()).definitions).toEqual([f.definition])
    for (const format of ['csv', 'markdown'] as const) {
      const sourcePath = join(f.options.directory, `profiles.${format}`)
      await writeFile(sourcePath, format === 'csv' ? 'seat\nimported-seat\n' : '| seat |\n| --- |\n| imported-seat |\n')
      const preview = await profiles.preview({ format, sourcePath, columnMap: { seat: 'seat' }, defaults: f.definition })
      expect(preview).not.toHaveProperty('status', 'rejected')
    }
    controller.abort()
    await expect(profiles.read()).rejects.toThrow('Authenticated owner')
  } finally { await f.close() }
})
