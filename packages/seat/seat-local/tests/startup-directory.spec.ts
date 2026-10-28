/** Registered manual directory choices use the real Loader and durable opening executor. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { OpenSeatRequest } from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'

it('freezes a registered startup choice through creation, workspace placement and reload without changing the catalog', async () => {
  const f = await admissionHost()
  try {
    const chosen = join(f.options.directory, 'chosen')
    await mkdir(chosen)
    const directories = [...f.definition.directories, { path: chosen, startup: false }]
    expect(await f.seats.save({ definition: { ...f.definition, directories }, expectedRevision: 2,
      operationId: operation('register-directory') })).toMatchObject({ status: 'saved' })
    const request: OpenSeatRequest = { seat: f.definition.seat, origin: 'manual', openingMode: 'prefill',
      startupDirectory: chosen, operationId: operation('chosen-opening') }
    const first = await f.seats.open(request)
    expect(first).toMatchObject({ status: 'prefilled' })
    if (first.status !== 'prefilled') throw new Error('Opening did not return a draft')
    expect((await f.ctx.sessionPersistence.stat(first.sessionId))?.header.cwd).toBe(chosen)
    expect(await f.seats.binding({ sessionId: first.sessionId })).toMatchObject({ kind: 'seat', directories: [
      { path: f.options.directory, startup: false }, { path: chosen, startup: true },
    ] })
    expect(f.ctx.workspaceRegistry.list().some(workspace => workspace.path === chosen)).toBe(true)
    expect((await f.seats.resolve(f.definition.seat))).toMatchObject({ directories })
    const accepted = (await f.state.read()).effects.find(effect => effect.kind === 'trigger/accepted')
    expect(accepted).toMatchObject({ data: { pending: { frozenOpen: { definition: { directories: [
      { path: f.options.directory, startup: false }, { path: chosen, startup: true },
    ] } } } } })
    const restored = await f.reload()
    const { stateVersion: _version, ...opening } = first
    expect(await restored.open(request)).toMatchObject(opening)
    expect((await f.ctx.sessionPersistence.stat(first.sessionId))?.header.cwd).toBe(chosen)
    expect(await restored.binding({ sessionId: first.sessionId })).toMatchObject({ kind: 'seat', directories: [
      { path: f.options.directory, startup: false }, { path: chosen, startup: true },
    ] })
    expect(await restored.open({ ...request, startupDirectory: f.options.directory }))
      .toMatchObject({ status: 'rejected', error: { code: 'operation-id-conflict' } })
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.close() }
})

it('rejects unregistered directories and nonmanual overrides before admission or Session creation', async () => {
  const f = await admissionHost()
  try {
    const before = (await f.state.read()).watermark
    expect(await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill',
      startupDirectory: join(f.options.directory, 'unregistered'), operationId: operation('unregistered') }))
      .toMatchObject({ status: 'rejected', error: { code: 'invalid-request' } })
    const remote = f.ctx.seats.withAuthority({ ...f.authority, origin: 'remote' })
    expect(await remote.open({ seat: f.definition.seat, origin: 'remote', startupDirectory: f.options.directory,
      operationId: operation('nonmanual') })).toMatchObject({ status: 'rejected', error: { code: 'invalid-request' } })
    expect((await f.state.read()).watermark).toBe(before)
    expect(await f.ctx.sessionPersistence.list()).toHaveLength(0)
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.close() }
})
