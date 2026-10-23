/** Keyless seat profile exercises production providers through the Loader. */
import { expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHost } from './fixtures/e2e-host.ts'
import { operation } from './fixtures/e2e-config.ts'

it('imports seat-a, opens with the mock model, publishes callbacks, lists and closes the window', async () => {
  const f = await createHost()
  try {
    await f.mount()
    const sourcePath = join(f.root, 'seats.csv')
    await writeFile(sourcePath, 'seat,model\nseat-a,model-a\n')
    const seats = f.seats()
    const plan = await seats.previewImport({ format: 'csv', sourcePath, columnMap: { seat: 'seat', model: 'model' }, defaults: {} })
    expect(plan).toHaveProperty('planId')
    if ('status' in plan) throw new Error(JSON.stringify(plan))
    expect(plan.rows).toHaveLength(1)
    expect(plan.rows[0]?.diagnostics).toEqual([])
    expect(await seats.commitImport({ planId: plan.planId, selectedRows: [plan.rows[0]!.row],
      expectedRevision: 0, operationId: operation('import-a') })).toMatchObject({ status: 'committed' })
    const opened = await seats.open({ seat: f.config.definition.seat, origin: 'manual', operationId: operation('open-a') })
    expect(opened).toMatchObject({ status: 'opened' })
    if (opened.status !== 'opened') throw new Error(JSON.stringify(opened))
    try { await expect.poll(() => f.model.requests.length, { timeout: 5000 }).toBe(1) }
    catch (error) {
      console.info(JSON.stringify({ events: f.ctx.agents.get(opened.sessionId)?.session.snapshotEvents(),
        engine: await f.ctx.get('seatEngine')!.query({ limit: 100 }) }))
      throw error
    }
    await f.ctx.agents.get(opened.sessionId)!.whenIdle()
    await f.ctx.get('seatEngine')!.drive()
    expect(JSON.stringify(f.model.requests[0])).toContain('Open seat-a.')
    const ledger = await f.ctx.sessionLedger.query({ sessionId: opened.sessionId })
    expect(ledger.rows.filter(row => row.kind === 'run')).toHaveLength(1)
    expect(ledger.rows.find(row => row.kind === 'run')?.start).toMatchObject({ seat: 'seat-a' })
    const listed = await seats.list({})
    expect(listed).toMatchObject({ status: 'listed', sessions: [{ sessionId: opened.sessionId, seat: 'seat-a', evidence: 'complete' }] })
    if (listed.status !== 'listed') throw new Error(JSON.stringify(listed))
    expect(await seats.close({ sessionId: opened.sessionId, operationId: operation('close-a'),
      expectedStateVersion: listed.sessions[0]!.stateVersion })).toMatchObject({ status: 'closed' })
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(opened.sessionId)
    expect(await seats.list({})).toMatchObject({ status: 'listed', sessions: [], unopenedSeats: ['seat-a'] })
    const events = await f.ctx.get('seatEngine')!.query({ limit: 100 })
    expect(JSON.stringify(events)).toContain('callback/delivered')
    expect(JSON.stringify(events)).toContain('window/closed')
  } finally { await f.close() }
}, 30000)
