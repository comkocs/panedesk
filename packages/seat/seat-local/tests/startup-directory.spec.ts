/** Registered manual directory choices use the real Loader and durable opening executor. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { OpenSeatRequest } from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { createOpenExecutor } from '../src/executor.ts'

it('freezes a startup choice through creation, workspace placement and reload without changing the catalog', async () => {
  const f = await admissionHost()
  try {
    const chosen = join(f.options.directory, 'chosen')
    await mkdir(chosen)
    const directories = f.definition.directories
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
    expect(f.ctx.workspaceRegistry.list().find(workspace => workspace.path === chosen)?.sessionIds).toContain(first.sessionId)
    expect(first.draft).toBeTruthy()
    expect(f.ctx.agents.get(first.sessionId)?.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(0)
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

it('retries interrupted workspace attachment without duplicating membership or sending the opening draft', async () => {
  const f = await admissionHost()
  try {
    const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill',
      operationId: operation('attach-recovery') })
    if (opened.status !== 'prefilled') throw new Error('Opening did not return a draft')
    const fact = (await f.state.read()).effects.findLast(effect => effect.kind === 'open/configured')
    if (fact?.kind !== 'open/configured') throw new Error('Configured opening is unavailable')
    const target = await f.ctx.workspaceRegistry.create(f.options.directory)
    const attach = vi.spyOn(target, 'attachSession').mockRejectedValueOnce(new Error('Attachment interrupted'))
    const executor = createOpenExecutor(f.ctx, f.runtime, f.options)
    await expect(executor.configure(fact.data, 'workspace')).rejects.toThrow('Attachment interrupted')
    await executor.configure(fact.data, 'workspace')
    await executor.configure(fact.data, 'workspace')
    expect(attach).toHaveBeenCalledTimes(3)
    expect(target.sessionIds.filter(id => id === opened.sessionId)).toHaveLength(1)
    const restored = await f.reload()
    expect(await restored.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill',
      operationId: operation('attach-recovery') })).toMatchObject({ sessionId: opened.sessionId, draft: opened.draft })
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.close() }
})
