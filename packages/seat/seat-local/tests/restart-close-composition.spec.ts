/** A restarted host can acquire an old Session solely for guarded close. */
import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'

it('opens, restarts and closes the same window without reviving a fenced turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seat-restart-close-'))
  let host: Awaited<ReturnType<typeof admissionHost>> | undefined
  try {
    host = await admissionHost(root)
    const opened = await host.seats.open({ seat: host.definition.seat, origin: 'manual', openingMode: 'prefill',
      operationId: operation('restart-open') })
    if (opened.status !== 'prefilled') throw new Error(JSON.stringify(opened))
    await host.close()
    host = undefined
    host = await admissionHost(root)
    await host.engine.drive()
    const listed = await host.seats.list({})
    if (listed.status !== 'listed' || !listed.sessions[0]) throw new Error(JSON.stringify(listed))
    expect(listed.sessions[0].busyReasons.some(reason => reason.kind === 'owner-unknown')).toBe(true)
    expect(await host.engine.admitTurn(opened.sessionId)).toEqual({ status: 'defer', reason: 'owner-unknown' })
    const first = await host.seats.close({ sessionId: opened.sessionId,
      expectedStateVersion: listed.sessions[0].stateVersion, operationId: operation('restart-close') })
    if (first.status === 'conflict') {
      const current = await host.seats.list({})
      if (current.status !== 'listed' || !current.sessions[0]) throw new Error(JSON.stringify(current))
      expect(await host.seats.close({ sessionId: opened.sessionId, expectedStateVersion: current.sessions[0].stateVersion,
        operationId: operation('restart-close-current') })).toMatchObject({ status: 'closed' })
    } else expect(first).toMatchObject({ status: 'closed' })
    expect(host.ctx.workspaceRegistry.archivedSessionIds).toContain(opened.sessionId)
    expect(host.adapter.requests).toHaveLength(0)
    expect(await host.engine.admitTurn(opened.sessionId)).toEqual({ status: 'defer', reason: 'owner-unknown' })
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }) }
})
