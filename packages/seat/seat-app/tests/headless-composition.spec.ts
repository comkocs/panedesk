import { expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHost } from './fixtures/e2e-host.ts'
import { operation } from './fixtures/e2e-config.ts'
import { completesTurn, inputContains } from '../../seat/tests/completion.ts'

it('assembles controlled headless seat creation and completes one durable opening input', async () => {
  const patch = await readFile(new URL('../headless.cordis.patch.yml', import.meta.url), 'utf8')
  for (const file of ['cordis.yml', 'cordis.snapshot.yml']) {
    const snapshot = await readFile(new URL(`../../../../snapshots/session/seat-opening/${file}`, import.meta.url), 'utf8')
    expect(snapshot).toContain(patch.trim())
  }
  const f = await createHost(undefined, true)
  try {
    await f.mount()
    const sourcePath = join(f.root, 'seats.csv')
    await writeFile(sourcePath, 'seat,model\nseat-a,model-a\n')
    const seats = f.seats()
    const plan = await seats.previewImport({ format: 'csv', sourcePath,
      columnMap: { seat: 'seat', model: 'model' }, defaults: {} })
    if ('status' in plan) throw new Error(JSON.stringify(plan))
    expect(await seats.commitImport({ planId: plan.planId, selectedRows: [plan.rows[0]!.row],
      expectedRevision: 0, operationId: operation('import-headless') })).toMatchObject({ status: 'committed' })
    const started = performance.now()
    const opened = await completesTurn(f.ctx, () => true, inputContains('Open seat-a.'), () =>
      seats.open({ seat: f.config.definition.seat, origin: 'manual', operationId: operation('open-headless') }))
    const elapsed = performance.now() - started
    process.stdout.write(`${JSON.stringify({ measurement: 'headless-seat-opening-completed', elapsedMs: elapsed })}\n`)
    expect(opened).toMatchObject({ status: 'opened' })
    if (opened.status !== 'opened') throw new Error(JSON.stringify(opened))
    await f.ctx.agents.get(opened.sessionId)!.whenIdle()
    await f.ctx.get('seatEngine')!.drive()
    const session = f.ctx.agents.get(opened.sessionId)!.session
    await f.ctx.sessions.flush(session)
    expect(session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'message-delivery')).toHaveLength(1)
    expect(f.model.requests).toHaveLength(1)
    expect(JSON.stringify(f.model.requests[0])).toContain('Open seat-a.')
    expect((await f.ctx.sessionPersistence.stat(opened.sessionId))?.header.id).toBe(opened.sessionId)
  } finally { await f.close() }
}, 30000)
