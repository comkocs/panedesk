/** Generated Remote, settings registration and navigation through the production Client Loader. */
import { Context } from '@panedesk/cordis'
import * as gateway from '@panedesk/dsh-api-gateway/client'
import type { ConnectionHandle } from '@panedesk/dsh-client-connection/client'
import { LocaleRuntime } from '@panedesk/dsh-client-locale/client'
import * as resources from '@panedesk/dsh-client-resources/client'
import { SlotRegistry } from '@panedesk/dsh-client-ui-renderer/client'
import { createInProcessModules } from '@panedesk/dsh-client-test-runtime/src/assembly/modules.ts'
import { graphFromRoster } from '@panedesk/dsh-client-test-runtime/src/assembly/roster.ts'
import { assertEntriesActive, bootClient } from '@panedesk/dsh-client-web/src/boot-client.ts'
import TypertRegistry from '@panedesk/dsh-typert-registry'
import type { PropsRenderSlots } from '@panedesk/dsh-client-ui-slots'
import type { SeatName } from '@panedesk/dsh-seat/types'
import { expect, it, vi } from 'vitest'
import * as profiles from '../src/client/index.ts'
import type { ProfileActions } from '../src/client/Profiles.tsx'

function Shell({ renderSlot }: PropsRenderSlots<'settings.section'>) { return renderSlot('settings.section', { close() {} }) }

it('loads the settings editor, navigates its declared store and withdraws all registrations', async () => {
  const ctx = new Context()
  const call = vi.fn<ConnectionHandle['rpc']['call']>().mockResolvedValue({ ok: true, value: {
    revision: 1, engineSequence: 0, authority: 'seat-store', definitions: [], windows: [], pending: [], recentOpen: {},
  } })
  try {
    await ctx.plugin(TypertRegistry)
    ctx.provide('connection', {
      interactions: 'answer', isLoopback: true,
      generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
      state: { getSnapshot: () => undefined, subscribe: () => () => {} },
      rpc: { call, open: async function* () { throw new Error('Unexpected stream') } },
      openWebSocket: () => { throw new Error('Unexpected socket') }, start: () => ({ stop() {} }),
      reconnect() {}, registerGenerationSource: () => () => {},
    } satisfies ConnectionHandle)
    await ctx.plugin(gateway)
    await ctx.plugin(SlotRegistry)
    await ctx.plugin(resources)
    ctx.provide('locale', new LocaleRuntime(ctx))
    const openSection = vi.fn()
    ctx.provide('settingsNavigation', { openSection })
    const removeShell = ctx.slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } }, Shell)
    const name = '@panedesk/dsh-client-ui-seat-profiles'
    const modules = createInProcessModules(graphFromRoster([{ name, inject: [], immediately: false }]), new Map([[name, profiles]]))
    await bootClient({ ctx, modules, manifest: modules.manifest })
    expect(() =>{  assertEntriesActive(ctx, modules) }).not.toThrow()
    await vi.waitFor(() =>{  expect(ctx.slots.entries('settings.section')).toHaveLength(1) })
    ctx.seatProfilesNavigation.open('seat-a' as SeatName)
    expect(openSection).toHaveBeenCalledWith('seat-profiles')
    const entry = ctx.slots.entries('settings.section')[0]
    const store = entry?.store
    const handle = typeof store === 'function' ? store() : store
    expect(handle?.create().getSnapshot()).toEqual({ seat: 'seat-a' })
    const source = ctx.resources.source('dsh-resource://seat-profiles/local')
    const release = source.subscribe(() => {})
    await vi.waitFor(() =>{  expect(source.getSnapshot()).toMatchObject({ status: 'live', value: { revision: 1 } }) })
    release()
    const face = entry?.inject?.() as ProfileActions | undefined
    if (!face) throw new Error('Profile actions unavailable')
    call.mockRejectedValueOnce(new Error('Timed out'))
    await expect(face.save({ seat: 'seat-a', revision: 2 }, 1)).rejects.toThrow('gateway/internal')
    const first = call.mock.calls.at(-1)?.[2]
    call.mockResolvedValueOnce({ ok: true, value: { status: 'saved', revision: 2 } })
    await expect(face.save({ seat: 'seat-a', revision: 2 }, 1)).resolves.toBe(2)
    expect(call.mock.calls.at(-1)?.[2]).toEqual(first)
    removeShell()
    expect(ctx.get('seatProfilesNavigation')).toBeUndefined()
    expect(ctx.slots.entries('settings.section')).toHaveLength(0)
  } finally { await ctx.fiber.dispose() }
  expect(ctx.get('remote.seatProfiles')).toBeUndefined()
})
