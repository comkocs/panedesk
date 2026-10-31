/** Real Loader profile exercises catalog editing, owner checks and adapter withdrawal. */
import { expect, it } from 'vitest'
import { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import Profiles from '../src/index.ts'
import { admissionHost } from '../../../seat/seat-local/tests/admission-host.ts'

it('loads profile editing through Loader and retains CAS, deletion impact and actual opening facts', async () => {
  const f = await admissionHost()
  try {
    Object.assign(f.ctx.loader.builtins, { profiles: Profiles })
    const entry = await f.load('profiles.yml', [{ name: 'cordis:profiles' }])
    const remote = f.ctx.get('seatProfiles')
    if (!remote) throw new Error('Profile adapter did not load')
    const controller = new AbortController()
    Object.defineProperty(f.ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } }, signal: controller.signal } })
    const initial = await remote.read()
    expect(initial).toMatchObject({ revision: 2, authority: 'seat-store', recentOpen: {} })
    expect(await remote.save({ definitionJson: JSON.stringify({ ...f.definition, revision: 2, model: 'model-b' }),
      expectedRevision: initial.revision - 1, operationId: 'stale-edit' as T.SeatOperationId }))
      .toMatchObject({ status: 'rejected', error: { code: 'revision-conflict' } })
    expect((await remote.read()).definitions[0]?.model).toBe('model-a')
    expect(await remote.save({ definitionJson: '{', expectedRevision: initial.revision, operationId: 'invalid-json' as T.SeatOperationId }))
      .toMatchObject({ status: 'rejected', error: { code: 'invalid-definition' } })
    const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill', operationId: 'profile-open' as T.SeatOperationId })
    if (opened.status !== 'prefilled') throw new Error('Expected a prefilled window')
    const observed = await remote.read()
    const created = f.engine.journal.projection.decisions.findLast(frame => frame.effects.some(effect => effect.kind === 'open/created'))
    expect(observed.recentOpen[f.definition.seat]).toBe(created?.observedAt)
    expect(observed.windows.map(window => window.sessionId)).toContain(opened.sessionId)
    const request = { seat: f.definition.seat, expectedRevision: observed.revision, operationId: 'profile-remove' as T.SeatOperationId,
      confirmed: true as const, windows: [opened.sessionId], pending: [] }
    expect(await remote.deleteProfile({ ...request, windows: [], operationId: 'stale-impact' as T.SeatOperationId }))
      .toMatchObject({ status: 'rejected', error: { code: 'revision-conflict' } })
    expect(await remote.deleteProfile(request)).toEqual({ status: 'saved', revision: 3 })
    expect(await remote.deleteProfile(request)).toEqual({ status: 'saved', revision: 3 })
    expect((await remote.read()).definitions).toEqual([])
    expect(f.ctx.get('agents')?.get(opened.sessionId)).toBeDefined()
    controller.abort()
    await expect(remote.read()).rejects.toThrow('Authenticated owner')
    await f.ctx.loader.resolve(entry).fiber?.dispose()
    expect(f.ctx.get('seatProfiles')).toBeUndefined()
  } finally { await f.close() }
})

it('refuses a guest before accessing the catalog provider', async () => {
  const ctx = new Context()
  try {
    Object.defineProperty(ctx, 'invocation', { value: { peer: { principal: { kind: 'guest' } }, signal: new AbortController().signal } })
    const remote = new Profiles(ctx)
    await expect(remote.read()).rejects.toThrow('Authenticated owner')
    expect(() => remote.save({ definitionJson: '{}', expectedRevision: 0, operationId: 'guest-edit' as T.SeatOperationId })).toThrow('Authenticated owner')
  } finally { await ctx.fiber.dispose() }
})
