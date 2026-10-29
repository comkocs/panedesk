/** Real providers retain external authorization while gates consume internal reads. */
import { expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolCallId } from '@panedesk/dsh-llm'
import { localHost } from './local-host.ts'
import { operation } from '../../seat-local/tests/fixtures.ts'

it('reads definitions during input preparation, delivers one opening and persists the model reply while external calls stay unauthorized', async () => {
  const f = await localHost()
  try {
    await mkdir(join(f.root, 'memory'))
    const memory = join(f.root, 'memory/note.md')
    await writeFile(memory, 'before')
    const sourcePath = join(f.root, 'seats.csv')
    await writeFile(sourcePath, 'seat,model\nseat-a,model-a\nseat-b,model-a\n')
    const plan = await f.seats.previewImport({ format: 'csv', sourcePath, columnMap: { seat: 'seat', model: 'model' }, defaults: {} })
    if ('status' in plan) throw new Error(JSON.stringify(plan))
    expect(plan.rows.map(row => row.diagnostics)).toEqual([[], []])
    expect(await f.seats.commitImport({ planId: plan.planId, selectedRows: plan.rows.map(row => row.row),
      expectedRevision: 0, operationId: operation('import-a') })).toMatchObject({ status: 'committed' })
    const external = f.ctx.get('seats')!
    await expect(external.definitions({})).rejects.toThrow('Verified authority is required.')
    await expect(external.list({})).rejects.toThrow('Verified authority is required.')
    const read = f.ctx.get('seatLocalRead')!
    expect(Object.keys(read).sort()).toEqual(['binding', 'definitions', 'list', 'messageWindows'])
    const page = await read.definitions({})
    expect(page).toMatchObject({ complete: false, definitions: [{ seat: 'seat-a' }] })
    expect(await read.definitions({ cursor: page.nextCursor! })).toMatchObject({ complete: true, definitions: [{ seat: 'seat-b' }] })
    const inputs: string[] = []
    f.ctx.on('agent/input-preparing', async ({ agent }) => {
      inputs.push(agent.id)
      await writeFile(memory, 'after')
    })
    const opened = await f.seats.open({ seat: f.defaults.seat, origin: 'manual', operationId: operation('open-a') })
    expect(opened).toMatchObject({ status: 'opened' })
    if (opened.status !== 'opened') throw new Error(JSON.stringify(opened))
    await expect.poll(() => f.model.requests.length, { timeout: 5000 }).toBe(1)
    const agent = f.ctx.agents.get(opened.sessionId)!
    await agent.whenIdle()
    await f.ctx.sessions.flush(agent.session)
    await f.ctx.get('seatEngine')!.drive()
    expect(inputs).toContain(opened.sessionId)
    expect(JSON.stringify(f.model.requests[0])).toContain('Open seat-a.')
    const events = (await f.ctx.sessionQuery.readSession(opened.sessionId)).events
    const user = events.find(event => event.type === 'user/message')
    if (user?.type !== 'user/message') throw new Error('Opening was not persisted')
    await expect.poll(async () => (await f.ctx.get('messageDelivery')!.status(user.data.id)).state).toBe('responded')
    expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(JSON.stringify(events)).toContain('Opening received.')
    const facts = await f.ctx.get('seatEngine')!.query({ limit: 1000 })
    const audit = facts.effects.find(effect => effect.kind === 'memory/audit')
    if (audit?.kind !== 'memory/audit') throw new Error('Memory audit was not committed')
    expect(audit.data.paths.map(item => item.path)).toEqual([memory])
    expect(facts.effects).toContainEqual(expect.objectContaining({ kind: 'callback/delivered' }))
    await expect(external.binding({ sessionId: agent.id })).rejects.toThrow('Verified authority is required.')
    const listed = await f.ctx.agents.withInitiator(agent, () => f.ctx.tools.execute({ name: 'seat_windows', arguments: {}, agent,
      callId: ToolCallId('list-a'), signal: new AbortController().signal }))
    expect(listed.isError).toBe(false)
    expect(JSON.stringify(listed.content)).toContain(opened.sessionId)
    await expect(external.definitions({})).rejects.toThrow('Verified authority is required.')
    expect(f.model.requests).toHaveLength(1)
    await f.unmount()
    expect(f.ctx.get('seatLocalRead')).toBeUndefined()
    expect(f.ctx.get('seatGates')).toBeUndefined()
  } finally { await f.close() }
}, 30000)
