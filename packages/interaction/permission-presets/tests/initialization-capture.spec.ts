/** Concurrent initialization publishes permission facts once. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import SessionStore, { SessionId } from '@panedesk/dsh-session'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import PermissionPresetService from '../src/index.ts'
import { expect, it, onTestFinished } from 'vitest'

it('publishes initial permission facts once for concurrent public initialization', async () => {
  const root = mkdtempSync(join(tmpdir(), 'permission-initialization-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const patch = join(workspace, 'cordis.patch.yml')
  writeFileSync(patch, '[]')
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('shell', { sandboxMode: 'workspace-write' })
  ctx.provide('approval', { config: { policy: 'ask' } })
  ctx.provide('profileContext', {
    name: 'test', dir: workspace, patchPath: patch, home: join(root, 'owner'), cwd: workspace,
    installAnchor: join(root, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  await ctx.plugin(PermissionPresetService)
  const session = ctx.sessions.prepare(SessionId('concurrent-initialization'), { meta: { cwd: workspace } })
  const first = ctx.permissionPresets.initialize(session, 'never')
  const second = ctx.permissionPresets.initialize(session)
  await Promise.all([first, second])
  expect(session.snapshotEvents().map(event => [event.type, event.data])).toEqual([
    ['permission/preset', { preset: 'workspace-write' }],
    ['sandbox/mode', { mode: 'workspace-write' }],
    ['approval/policy', { policy: 'never' }],
  ])
  await Promise.all([ctx.permissionPresets.initialize(session, 'ask'), ctx.permissionPresets.initialize(session, 'never')])
  expect(session.snapshotEvents().slice(3).map(event => [event.type, event.data])).toEqual([
    ['approval/policy', { policy: 'ask' }],
    ['approval/policy', { policy: 'never' }],
  ])
})
