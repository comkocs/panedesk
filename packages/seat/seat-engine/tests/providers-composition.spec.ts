/** Loader mounts production policy beside the real child manager and local jobs. */
import { expect, it } from 'vitest'
import SubagentRuntime, { type SubagentActivationSpec, type SubagentResult } from '@panedesk/dsh-subagent'
import LocalJobRegistry from '@panedesk/dsh-jobs-local'
import LocalFileSystem from '@panedesk/dsh-fs-local'
import WorkingDirectory from '@panedesk/dsh-working-directory'
import { SessionId } from '@panedesk/dsh-session'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { composition } from './composition-fixture.ts'
import { SeatEngine } from '../src/engine.ts'
import { auto, sourceId, trigger } from './fixtures.ts'

it('queues the fifth child in the production FIFO and releases it after the fourth completes', async () => {
  const f = await composition(false, { builtins: { subagents: SubagentRuntime, jobs: LocalJobRegistry,
    fs: LocalFileSystem, directory: WorkingDirectory }, entries: [{ name: 'cordis:fs', config: {} },
    { name: 'cordis:directory', config: {} }, { name: 'cordis:subagents' }, { name: 'cordis:jobs', config: {} }] })
  try {
    await expect.poll(() => f.ctx.get('subagentAdmission') !== undefined).toBe(true)
    const engine = f.ctx.seatEngine
    if (!(engine instanceof SeatEngine)) throw new Error('Missing production engine')
    engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: async () => {} })
    engine.registerExecutor({ observe: async open => f.ctx.agents.get(open.sessionId) ? 'matching' : 'absent',
      create: async open => (await f.ctx.agents.create({ sessionId: open.sessionId,
        agentOptions: { provider: 'mock', model: 'model-a' } })).agent.id, configure: async () => {},
      opening: async () => ({ messageId: 'opening-a' as never, state: 'completed' }), owner: async () => 'alive',
      wakeSender: async () => 'sent' })
    await auto(engine)
    await engine.accept(trigger())
    await engine.drive()
    const open = [...engine.journal.projection.opens.values()][0]
    const parent = open && f.ctx.agents.get(open.sessionId)
    if (!parent) throw new Error('Missing production parent')
    const results: PromiseWithResolvers<SubagentResult>[] = []
    f.ctx.subagents.registerProvider({ name: 'mock-child', inheritsParentContext: false,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      start: async () => {
        const result = Promise.withResolvers<SubagentResult>(); results.push(result)
        return { id: SessionId(`child-${results.length}`), result: result.promise,
          dispose: async () => { result.resolve({ output: [], stopReason: 'aborted' }) } }
      } })
    const spec = (label: string): SubagentActivationSpec => ({ provider: 'mock-child', label, delivery: 'caller',
      signal: new AbortController().signal, request: { parent, prompt: [{ type: 'text', text: label }] } })
    const active = []
    for (let index = 0; index < 4; index++) active.push(await f.ctx.subagents.startActivation(spec(`work-${index}`)))
    const fifth = await f.ctx.subagents.requestActivation(spec('fifth'))
    expect(fifth).toMatchObject({ status: 'queued', parentSessionId: parent.id })
    expect(results).toHaveLength(4)
    const queued = [...engine.journal.projection.children.values()].find(item => item.phase === 'queued')
    expect(queued?.activation).toMatchObject({ label: 'fifth' })
    const start = performance.now()
    results[3]?.resolve({ output: [], stopReason: 'completed' })
    await active[3]?.result
    expect(results).toHaveLength(5)
    expect(performance.now() - start).toBeLessThanOrEqual(5000)
    for (const result of results) result.resolve({ output: [], stopReason: 'completed' })
    await Promise.all(active.map(item => item.result))
    await expect.poll(() => [...engine.journal.projection.children.values()].filter(item => item.phase === 'admitted').length).toBe(0)
    f.adapter.finish()
    const notifying = await f.ctx.subagents.startActivation({ ...spec('notify parent'), delivery: 'parent' })
    results.at(-1)?.resolve({ output: [{ type: 'text', text: 'Child finished its task.' }], stopReason: 'completed' })
    await notifying.result
    await expect.poll(() => f.adapter.requests.length).toBe(1)
    await parent.whenIdle()
    expect((await f.ctx.messageDelivery.list({ targetSessionId: parent.id })).items).toHaveLength(1)
    expect(JSON.stringify(f.adapter.requests)).toContain('Child finished its task.')
  } finally { await f.close() }
}, 20000)

it('persists a real local job before side effects and delivers one durable waking completion', async () => {
  const f = await composition(false, { builtins: { jobs: LocalJobRegistry }, entries: [{ name: 'cordis:jobs', config: {} }] })
  try {
    await expect.poll(() => f.ctx.get('jobNotifications') !== undefined).toBe(true)
    f.adapter.finish()
    const parent = (await f.ctx.agents.create({ sessionId: SessionId('parent-a'), agentOptions: { provider: 'mock', model: 'model-a' } })).agent
    f.ctx.jobs.attachController('test')
    const done = Promise.withResolvers<{ status: 'completed' }>()
    const id = f.ctx.jobs.start({ kind: 'bash', label: 'one completion', owner: parent.id,
      run: () => ({ done: done.promise, cancel: () => { done.resolve({ status: 'completed' }) } }) })
    const engine = f.ctx.seatEngine
    if (!(engine instanceof SeatEngine)) throw new Error('Missing engine')
    const root = join(engine.journal.root, 'notifications')
    const files = await readdir(root)
    expect(files).toHaveLength(1)
    expect(await readFile(join(root, files[0] ?? ''), 'utf8')).toContain(id)
    done.resolve({ status: 'completed' })
    await f.ctx.jobs.wait(id, 1000, parent.id)
    await expect.poll(() => f.adapter.requests.length).toBe(1)
    await parent.whenIdle()
    const messages = await f.ctx.messageDelivery.list({ targetSessionId: parent.id })
    expect(messages.items).toHaveLength(1)
    expect(f.ctx.jobs.notificationState(id, parent.id)).toBe('accepted')
    expect(JSON.stringify(f.adapter.requests)).toContain('one completion')
  } finally { await f.close() }
}, 20000)
