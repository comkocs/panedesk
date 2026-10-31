/** First admission reads committed workspace choices without a notification repair. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import ConfigEditor from '@panedesk/dsh-config-editor'
import Settings from '@panedesk/dsh-settings'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@panedesk/dsh-app-boot'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from '../../../seat/seat-local/tests/admission-host.ts'
import { digest } from '../../../seat/seat-engine/src/journal.ts'
import * as Onboarding from '../src/index.ts'

it.each(['off', 'remind', 'auto'] as const)('inherits %s on the first admission after importing a new project seat', async (mode) => {
  const h = await admissionHost()
  let dispose: (() => Promise<unknown>) | undefined
  try {
    const workspace = join(h.options.directory, 'new-workspace')
    await mkdir(workspace)
    const dir = join(h.options.directory, 'profile')
    initProfile(dir, ['test-onboarding'])
    const bundle = join(dir, 'node_modules', 'test-onboarding')
    await mkdir(bundle, { recursive: true })
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-onboarding', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
      { id: 'ui-project-onboarding', name: 'cordis:onboarding' },
    ] }]))
    await writeFile(join(dir, 'cordis.yml'), '[]\n')
    const profile: ProfileContext = { name: 'test', startedBundles: ['test-onboarding'], dir,
      patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(h.options.directory, 'package.json'),
      cwd: h.options.directory, home: h.options.directory, overlays: [], telemetryDisabledEnv: undefined }
    const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady: (listener) => { listener(); return () => {} } })
      ctx.provide('seatEngine', h.engine)
      ctx.provide('seats', h.ctx.get('seats'))
      Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, onboarding: Onboarding })
    })
    dispose = () => ctx.fiber.dispose()
    Object.defineProperty(ctx, 'invocation', { configurable: true,
      value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
    const revision = ctx.settings.describe().find(item => item.ns === 'ui-project-onboarding')!.revision
    await ctx.get('projectOpening')!.select(workspace, { mode, chosen: true }, revision)
    const sourcePath = join(h.options.directory, 'import.csv')
    await writeFile(sourcePath, 'seat\nnew-seat\n')
    const projectId = 'new-project' as T.SeatProjectId
    await h.seats.setAuthority({ authority: 'import-source', authorizationRef: 'user-a' as T.AuthorizationRef,
      expectedRevision: (await h.seats.definitions({})).revision, operationId: 'enable-import' as T.SeatOperationId })
    const plan = await h.seats.previewImport({ format: 'csv', sourcePath, columnMap: { seat: 'seat' },
      defaults: { ...h.definition, projectId, directories: [{ path: workspace, startup: true }] } })
    if ('status' in plan) throw new Error('Import preview failed')
    const catalog = await h.seats.definitions({})
    const imported = await h.seats.commitImport({ planId: plan.planId, selectedRows: plan.rows.map(row => row.row),
      expectedRevision: catalog.revision, operationId: 'import-new-seat' as T.SeatOperationId })
    expect(imported).toEqual(expect.objectContaining({ status: 'committed' }))
    const sourceId = 'import-source' as T.SeatSourceId
    const unregister = h.engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: async () => {} })
    try {
      const result = await h.engine.accept({ triggerId: 'first-import-trigger' as T.TriggerId, sourceId,
        eventId: 'first-import-event' as T.SourceEventId, kind: 'external', evidence: { kind: 'external', eventType: 'new-task' },
        seat: 'new-seat' as T.SeatName, projectId, receivedAt: new Date().toISOString(), dataDigest: digest(null), data: null,
        callbackRef: sourceId })
      expect(await h.engine.projectPolicy(projectId)).toMatchObject({ mode, modeChosen: true, revision: 1 })
      if (mode === 'off') expect(result).toMatchObject({ status: 'rejected', error: { code: 'disabled' } })
      else {
        expect(result).toMatchObject({ status: 'accepted' })
        expect((await h.engine.pending({ projectId, limit: 10 })).items[0]).toMatchObject({ effectiveMode: mode,
          reason: mode === 'remind' ? 'approval' : 'provider-unavailable' })
      }
      expect(h.adapter.requests).toHaveLength(0)
      await dispose()
      dispose = undefined
      const unregisterReplacement = h.engine.registerProjectPolicyResolver(() => undefined)
      unregisterReplacement()
      expect(await h.engine.projectPolicy(projectId)).toMatchObject({ mode, modeChosen: true, revision: 1 })
    } finally { await unregister() }
  } finally { await dispose?.(); await h.close() }
})
