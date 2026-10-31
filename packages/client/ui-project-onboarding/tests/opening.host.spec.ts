/** Real profile persistence and journal-backed opening-policy acceptance. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@panedesk/dsh-app-boot'
import ConfigEditor from '@panedesk/dsh-config-editor'
import Settings from '@panedesk/dsh-settings'
import type { SeatService, SeatProjectId, SeatName, SeatOperationId } from '@panedesk/dsh-seat'
import * as Onboarding from '../src/index.ts'
import { harness, projectId, definition } from '../../../seat/seat-engine/tests/fixtures.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function setup() {
  const h = await harness()
  cleanups.push(h.close)
  const dir = join(h.home, 'profile')
  initProfile(dir, ['test-onboarding'])
  const bundle = join(dir, 'node_modules', 'test-onboarding')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(h.home, 'package.json'), '{"name":"test-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-onboarding', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'ui-project-onboarding', name: 'cordis:onboarding' },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', startedBundles: ['test-onboarding'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(h.home, 'package.json'),
    cwd: h.home, home: h.home, overlays: [], telemetryDisabledEnv: undefined }
  const definitions = vi.fn(async () => ({ definitions: [...h.definitions.values()], complete: true, revision: 1 }))
  const withAuthority = vi.fn(() => ({ definitions }) as Pick<SeatService, 'definitions'> as SeatService)
  const start = async () => {
    const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady: (listener) => { listener(); return () => {} } })
      ctx.provide('seatEngine', h.engine)
      ctx.provide('seats', { withAuthority } as Pick<SeatService, 'withAuthority'> as SeatService)
      Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, onboarding: Onboarding })
    })
    cleanups.push(() => ctx.fiber.dispose())
    Object.defineProperty(ctx, 'invocation', { configurable: true,
      value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    return ctx
  }
  const ctx = await start()
  const revision = () => ctx.settings.describe().find(item => item.ns === 'ui-project-onboarding')!.revision
  return { ...h, ctx, profile, catalog: h.definitions, definitions, withAuthority, start, startEngine: h.start, revision }
}

it('loads guidance from a profile, persists once, changes actual engine policy, and survives restart', async () => {
  const h = await setup()
  const remote = h.ctx.get('projectOpening')!
  expect(h.ctx.settings.describe().find(item => item.ns === 'ui-project-onboarding')).toMatchObject({ autoGenerate: false, value: { projects: {} } })
  expect(await remote.select('/workspace', { mode: 'auto', chosen: true }, h.revision()))
    .toMatchObject({ value: { projects: { '/workspace': { mode: 'auto', chosen: true } } } })
  expect(await h.engine.projectPolicy(projectId)).toMatchObject({ mode: 'auto', modeChosen: true, revision: 1 })
  expect(h.withAuthority).toHaveBeenCalledWith({ principalId: 'owner', origin: 'manual', nodeId: 'node-a' })
  await remote.select('/workspace', { mode: 'off', chosen: true }, h.revision())
  expect(await h.engine.projectPolicy(projectId)).toMatchObject({ mode: 'off', revision: 2 })
  expect(h.creates).toEqual([])
  expect(await readFile(h.profile.patchPath, 'utf8')).toContain('/workspace')
  await h.ctx.fiber.dispose()
  expect(h.ctx.get('projectOpening')).toBeUndefined()
  const restarted = await h.start()
  expect(restarted.settings.describe().find(item => item.ns === 'ui-project-onboarding'))
    .toMatchObject({ value: { projects: { '/workspace': { mode: 'off', chosen: true } } } })
})

it('refuses guests, cancelled invocations, stale revisions, and unavailable catalog pages before writes', async () => {
  const h = await setup(), remote = h.ctx.get('projectOpening')!
  Object.defineProperty(h.ctx, 'invocation', { value: { peer: { principal: { kind: 'guest' } } } })
  await expect(remote.select('/workspace', { mode: 'auto', chosen: true }, h.revision())).rejects.toThrow('owner')
  Object.defineProperty(h.ctx, 'invocation', { value: { peer: { principal: { kind: 'owner' } }, signal: AbortSignal.abort() } })
  await expect(remote.select('/workspace', { mode: 'auto', chosen: true }, h.revision())).rejects.toThrow()
  Object.defineProperty(h.ctx, 'invocation', { value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
  await expect(remote.select('/workspace', { mode: 'auto', chosen: true }, h.revision() - 1)).rejects.toThrow('changed')
  h.definitions.mockResolvedValue({ definitions: [], complete: false, revision: 1 })
  await expect(remote.select('/workspace', { mode: 'auto', chosen: true }, h.revision())).rejects.toThrow('incomplete')
  expect(await h.engine.projectPolicy(projectId)).toMatchObject({ mode: 'remind', modeChosen: false, revision: 0 })
  expect(h.creates).toEqual([])
})

it('does not confirm a failed save and compensates the engine mode without masking conflicts', async () => {
  const h = await setup(), remote = h.ctx.get('projectOpening')!
  const mutate = vi.spyOn(h.ctx.settings, 'mutate').mockRejectedValue(new Error('Storage unavailable'))
  await expect(remote.select('/workspace', { mode: 'auto', chosen: true }, h.revision())).rejects.toMatchObject({
    code: 'project-opening/compensation', cause: { message: 'Storage unavailable' },
    details: { outcomes: [{ projectId, status: 'restored' }] },
  })
  expect(await h.engine.projectPolicy(projectId)).toMatchObject({ mode: 'remind', modeChosen: false, revision: 2 })
  expect(h.ctx.settings.describe().find(item => item.ns === 'ui-project-onboarding')).toMatchObject({ value: { projects: {} } })
  mutate.mockRestore()
  await remote.select('/other-workspace', { mode: 'remind', chosen: true }, h.revision())
  expect(await h.engine.projectPolicy(projectId)).toMatchObject({ mode: 'remind', modeChosen: false, revision: 2 })
  expect(h.creates).toEqual([])
  await h.engine.shutdown()
  expect(await (await h.startEngine()).projectPolicy(projectId)).toMatchObject({ mode: 'remind', modeChosen: false, revision: 2 })
})

it('converges all policy fields when a middle CAS conflict has already restored the original choice', async () => {
  const h = await setup(), remote = h.ctx.get('projectOpening')!
  const second = 'project-b' as SeatProjectId, third = 'project-c' as SeatProjectId
  h.catalog.set('seat-b' as SeatName, { ...definition('seat-b' as SeatName), projectId: second })
  h.catalog.set('seat-c' as SeatName, { ...definition('seat-c' as SeatName), projectId: third })
  await h.engine.setProjectMode({ projectId: third, mode: 'off', expectedRevision: 0,
    operationId: 'original-choice' as SeatOperationId })
  vi.spyOn(h.ctx.settings, 'mutate').mockImplementationOnce(async () => {
    await h.engine.resetProjectMode({ projectId: second, mode: 'remind', modeChosen: false, expectedRevision: 1,
      operationId: 'parallel-restoration' as SeatOperationId })
    throw new Error('Storage unavailable')
  })
  await expect(remote.select('/workspace', { mode: 'auto', chosen: true }, h.revision())).rejects.toMatchObject({
    code: 'project-opening/compensation', details: { outcomes: [
      { projectId: third, status: 'restored' }, { projectId: second, status: 'restored' }, { projectId, status: 'restored' },
    ] },
  })
  expect(await h.engine.projectPolicy(projectId)).toMatchObject({ mode: 'remind', modeChosen: false, revision: 2 })
  expect(await h.engine.projectPolicy(second)).toMatchObject({ mode: 'remind', modeChosen: false, revision: 2 })
  expect(await h.engine.projectPolicy(third)).toMatchObject({ mode: 'off', modeChosen: true, revision: 3 })
})

it('continues every compensation after a middle conflict and reports each outcome without overwriting the winner', async () => {
  const h = await setup(), remote = h.ctx.get('projectOpening')!
  const second = 'project-b' as SeatProjectId, third = 'project-c' as SeatProjectId
  h.catalog.set('seat-b' as SeatName, { ...definition('seat-b' as SeatName), projectId: second })
  h.catalog.set('seat-c' as SeatName, { ...definition('seat-c' as SeatName), projectId: third })
  vi.spyOn(h.ctx.settings, 'mutate').mockImplementationOnce(async () => {
    await h.engine.setProjectMode({ projectId: second, mode: 'off', expectedRevision: 1,
      operationId: 'concurrent-choice' as SeatOperationId })
    throw new Error('Storage unavailable')
  })
  await expect(remote.select('/workspace', { mode: 'auto', chosen: true }, h.revision())).rejects.toMatchObject({
    code: 'project-opening/compensation', details: { outcomes: [
      { projectId: third, status: 'restored' }, { projectId: second, status: 'conflict' },
      { projectId, status: 'restored' },
    ] },
  })
  expect(await h.engine.projectPolicy(projectId)).toMatchObject({ mode: 'remind', modeChosen: false, revision: 2 })
  expect(await h.engine.projectPolicy(third)).toMatchObject({ mode: 'remind', modeChosen: false, revision: 2 })
  expect(await h.engine.projectPolicy(second)).toMatchObject({ mode: 'off', modeChosen: true, revision: 2 })
  expect(h.ctx.settings.describe().find(item => item.ns === 'ui-project-onboarding')).toMatchObject({ value: { projects: {} } })
})
