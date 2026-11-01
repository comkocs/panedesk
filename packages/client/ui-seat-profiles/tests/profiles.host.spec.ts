/** Real Loader profile exercises catalog editing, owner checks and adapter withdrawal. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
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
      confirmed: true as const, windows: [opened.sessionId], pending: [], engineSequence: observed.engineSequence,
      windowVersions: observed.windows.map(({ sessionId, stateVersion }) => ({ sessionId, stateVersion })), pendingVersions: [] }
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

it('refuses confirmation after a pending approval changes state without changing identity', async () => {
  const f = await admissionHost()
  try {
    const access = f.ctx.get('seatProfilesLocal')
    if (!access) throw new Error('Profile access unavailable')
    Object.defineProperty(f.ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    const pending: T.PendingSeatItem = { queueItemId: 'approval-a' as T.QueueItemId, seat: f.definition.seat, reason: 'approval', stateVersion: 2,
      projectId: f.definition.projectId, triggerKind: 'manual', action: 'open', sequence: 1, effectiveMode: 'remind', blockedBy: [], sources: [],
      relatedTaskIds: [], queuedAt: '2026-01-01T00:00:00Z' }
    vi.spyOn(f.engine, 'pending').mockResolvedValue({ items: [pending], complete: true, watermark: 1 })
    const observed = await access.read()
    pending.stateVersion = 3
    expect(await access.remove({ seat: f.definition.seat, expectedRevision: observed.revision, operationId: 'changed-approval' as T.SeatOperationId,
      confirmed: true, windows: [], pending: [pending.queueItemId], windowVersions: [],
      pendingVersions: [{ queueItemId: pending.queueItemId, stateVersion: 2 }], engineSequence: f.engine.journal.projection.sequence }))
      .toMatchObject({ status: 'rejected', error: { code: 'revision-conflict' } })
    expect((await access.read()).definitions).toHaveLength(1)
  } finally { await f.close() }
})

it('refuses confirmation after an open window changes state without changing identity', async () => {
  const f = await admissionHost()
  try {
    const access = f.ctx.get('seatProfilesLocal')
    if (!access) throw new Error('Profile access unavailable')
    Object.defineProperty(f.ctx, 'invocation', { configurable: true,
      value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill',
      operationId: 'versioned-window' as T.SeatOperationId })
    if (opened.status !== 'prefilled') throw new Error('Expected a prefilled window')
    const observed = await access.read()
    const agent = f.ctx.get('agents')?.get(opened.sessionId)
    if (!agent) throw new Error('Expected the opened agent')
    agent.session.append('session/title', { title: 'Changed window', messageSeqs: [], source: { kind: 'user' } })
    await f.ctx.get('sessions')?.flush(agent.session)
    const current = await access.read()
    const before = observed.windows[0]?.stateVersion, after = current.windows[0]?.stateVersion
    if (before === null || before === undefined || after === null || after === undefined) throw new Error('Expected known window versions')
    expect(after).toBeGreaterThan(before)
    expect(await access.remove({ seat: f.definition.seat, expectedRevision: observed.revision,
      operationId: 'changed-window' as T.SeatOperationId, confirmed: true, windows: [opened.sessionId], pending: [],
      engineSequence: current.engineSequence,
      windowVersions: observed.windows.map(({ sessionId, stateVersion }) => ({ sessionId, stateVersion })), pendingVersions: [] }))
      .toMatchObject({ status: 'rejected', error: { code: 'revision-conflict' } })
    expect((await access.read()).definitions).toHaveLength(1)
  } finally { await f.close() }
})

it('restores the definition when the following engine check fails and permits a fresh confirmation', async () => {
  const f = await admissionHost()
  try {
    const access = f.ctx.get('seatProfilesLocal')
    if (!access) throw new Error('Profile access unavailable')
    Object.defineProperty(f.ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    const observed = await access.read()
    const request = { seat: f.definition.seat, expectedRevision: observed.revision, operationId: 'compensated-delete' as T.SeatOperationId,
      confirmed: true as const, windows: [], pending: [], windowVersions: [], pendingVersions: [], engineSequence: observed.engineSequence }
    vi.spyOn(f.engine.journal, 'commit').mockRejectedValueOnce(new Error('Engine check failed'))
    await expect(access.remove(request)).rejects.toThrow('Engine check failed')
    const restored = await access.read()
    expect(restored.definitions).toEqual(observed.definitions)
    expect(restored.revision).toBe(observed.revision + 2)
    expect(await access.remove({ ...request, expectedRevision: restored.revision, operationId: 'fresh-delete' as T.SeatOperationId }))
      .toEqual({ status: 'saved', revision: restored.revision + 1 })
  } finally { await f.close() }
})

it('replays a timed-out save without applying its durable write twice', async () => {
  const f = await admissionHost()
  try {
    const access = f.ctx.get('seatProfilesLocal')
    if (!access) throw new Error('Profile access unavailable')
    Object.defineProperty(f.ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    const observed = await access.read()
    const request = { definition: { ...f.definition, revision: 2, model: 'model-b' }, expectedRevision: observed.revision,
      operationId: 'timed-out-save' as T.SeatOperationId }
    const transport = async () => { await access.save(request); throw new Error('Timed out after commit') }
    await expect(transport()).rejects.toThrow('Timed out after commit')
    expect(await access.save(request)).toEqual({ status: 'saved', revision: observed.revision + 1 })
    const current = await access.read()
    expect(current.revision).toBe(observed.revision + 1)
    expect(current.definitions).toEqual([request.definition])
  } finally { await f.close() }
})

it('keeps a restarted dashboard readable and refuses deletion until the cold window is restored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seat-cold-window-'))
  let host: Awaited<ReturnType<typeof admissionHost>> | undefined
  try {
    host = await admissionHost(root)
    const opened = await host.seats.open({ seat: host.definition.seat, origin: 'manual', openingMode: 'prefill',
      operationId: 'cold-open' as T.SeatOperationId })
    if (opened.status !== 'prefilled') throw new Error('Expected a prefilled window')
    const warm = host
    await warm.close()
    host = undefined
    host = await admissionHost(root)
    const access = host.ctx.get('seatProfilesLocal')
    if (!access) throw new Error('Profile access unavailable')
    Object.defineProperty(host.ctx, 'invocation', { configurable: true,
      value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    const cold = await access.read()
    const coldWindow = cold.windows.find(item => item.sessionId === opened.sessionId)
    expect(coldWindow).toMatchObject({ seat: host.definition.seat, title: opened.title, nodeId: opened.nodeId, stateKnown: false })
    expect(coldWindow?.stateVersion).toBeNull()
    expect(cold.definitions.some(item => item.seat === host!.definition.seat)).toBe(true)
    const removal = { seat: host.definition.seat, expectedRevision: cold.revision, operationId: 'cold-remove' as T.SeatOperationId,
      confirmed: true as const, windows: [opened.sessionId], pending: [] as T.QueueItemId[], engineSequence: cold.engineSequence,
      windowVersions: cold.windows.map(({ sessionId, stateVersion }) => ({ sessionId, stateVersion })), pendingVersions: [] }
    expect(await access.remove(removal)).toMatchObject({ status: 'rejected', error: {
      code: 'evidence-unavailable',
      alternative: 'Open this window from the session list so it resumes, then retry.',
    } })
    expect((await access.read()).definitions).toHaveLength(cold.definitions.length)
    const other = { ...host.definition, seat: 'seat-b' as T.SeatName, revision: 1 }
    expect(await access.save({ definition: other, expectedRevision: cold.revision, operationId: 'warm-save' as T.SeatOperationId }))
      .toMatchObject({ status: 'saved' })
    const resumed = await host.ctx.sessionController.resolveAgent(opened.sessionId)
    if ('error' in resumed) throw new Error('Expected the historical window to resume')
    const ready = await access.read()
    const readyWindow = ready.windows.find(item => item.sessionId === opened.sessionId)
    expect(readyWindow?.stateKnown).toBe(true)
    expect(typeof readyWindow?.stateVersion).toBe('number')
    expect(await access.remove({ seat: host.definition.seat, expectedRevision: ready.revision, operationId: 'restored-remove' as T.SeatOperationId,
      confirmed: true, windows: [opened.sessionId], pending: [], engineSequence: ready.engineSequence,
      windowVersions: ready.windows.filter(item => item.seat === host!.definition.seat)
        .map(({ sessionId, stateVersion }) => ({ sessionId, stateVersion })), pendingVersions: [] }))
      .toMatchObject({ status: 'saved' })
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }) }
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
