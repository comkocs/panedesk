/** Durable product completion delivery wakes idle parents and steers busy parents once. */
import { expect, it, vi } from 'vitest'
import { SessionId } from '@panedesk/dsh-session'
import { NodeRegistry } from '../../../session/message-delivery-local/src/registry.ts'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as JobTools from '@panedesk/dsh-tool-jobs'
import { ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@panedesk/dsh-llm'
import type { JobOutcome } from '@panedesk/dsh-jobs'
import { CreationAdapter } from '../../seat-local/tests/creation-provider.ts'
import { operation } from '../../seat-local/tests/fixtures.ts'
import { localHost } from './local-host.ts'

class CompletionModel extends CreationAdapter {
  blockParent = false
  childPath = ''
  readonly entered = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (JSON.stringify(options.messages).includes('COMPLETE_CHILD_WORK')) {
      await writeFile(this.childPath, 'Child report persisted.')
      yield* super.stream(options)
      return
    }
    if (!this.blockParent) { yield* super.stream(options); return }
    this.blockParent = false
    this.requests.push(options)
    this.entered.resolve(undefined)
    await this.release.promise
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('busy-report'), name: 'seat_report',
      arguments: JSON.stringify({ canClose: false, waitingFor: [], nextOpen: { when: { kind: 'unspecified' }, prerequisites: [] }, stateVersion: 1 }) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

it('isolates a bad completion head and delivers each recovered parent exactly once', async () => {
  const f = await localHost()
  f.ctx.loader.builtins.jobTools = JobTools
  await f.load('isolation-job-tools.yml', [{ name: 'cordis:jobTools' }])
  const bad = await f.ctx.agents.create({ sessionId: SessionId('completion-parent-unavailable'),
    agentOptions: { provider: 'provider-a', model: 'model-a' } })
  const good = await f.ctx.agents.create({ sessionId: SessionId('completion-parent-ready'),
    agentOptions: { provider: 'provider-a', model: 'model-a' } })
  const notices = new Map<string, number>()
  const off = f.ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.includes('isolated completion'))) {
      notices.set(session.id, (notices.get(session.id) ?? 0) + 1)
    }
  })
  // Only the nondeterministic liveness observation is unavailable; persistence and sends remain real.
  // Invoke the captured method only with the registry receiver below.
  // oxlint-disable-next-line typescript/unbound-method
  const original = NodeRegistry.prototype.status
  const status = vi.spyOn(NodeRegistry.prototype, 'status').mockImplementation(async function (this: NodeRegistry, id) {
    return id === bad.agent.id ? 'unavailable' : original.call(this, id)
  })
  try {
    const settle = (owner: typeof bad.agent) => f.ctx.jobs.start({ kind: 'bash', label: 'isolated completion', owner: owner.id,
      run: () => ({ done: Promise.resolve({ status: 'completed' as const, detail: 'isolated completion' }), cancel() {} }) })
    const first = settle(bad.agent)
    await f.ctx.jobs.wait(first, 5000, bad.agent.id)
    const second = settle(good.agent)
    await f.ctx.jobs.wait(second, 5000, good.agent.id)
    await expect.poll(() => notices.get(good.agent.id) ?? 0, { timeout: 5000 }).toBe(1)
    expect(notices.get(bad.agent.id) ?? 0).toBe(0)
    status.mockRestore()
    await expect.poll(() => notices.get(bad.agent.id) ?? 0, { timeout: 5000 }).toBe(1)
    await Promise.all([bad.agent.whenIdle(), good.agent.whenIdle()])
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect([...notices.values()]).toEqual([1, 1])
    expect((await f.ctx.messageDelivery.list({ targetSessionId: bad.agent.id })).items).toHaveLength(1)
    expect((await f.ctx.messageDelivery.list({ targetSessionId: good.agent.id })).items).toHaveLength(1)
    await f.ctx.sessions.flush(good.agent.session)
    const stored = await f.ctx.sessionQuery.readSession(good.agent.id)
    const text = stored.events.flatMap(event => event.type === 'user/message' ? event.data.content.flatMap(block =>
      block.type === 'text' && block.text.includes('isolated completion') ? [block.text.replace(second, '<job>')] : []) : [])
    expect(text).toMatchInlineSnapshot(`
      [
        "Job <job>: isolated completion
      completed: isolated completion",
      ]
    `)
  } finally { status.mockRestore(); off(); await f.close() }
}, 30000)

for (const kind of ['command', 'child'] as const) for (const busy of [false, true]) {
  it(`delivers one durable ${kind} completion with path hints to an ${busy ? 'busy' : 'idle'} parent`, async () => {
    const model = new CompletionModel()
    const f = await localHost(model, {}, true, true, true)
    try {
      f.ctx.loader.builtins.jobTools = JobTools
      await f.load('job-tools.yml', [{ name: 'cordis:jobTools' }])
      const sourcePath = join(f.root, 'seats.csv')
      await writeFile(sourcePath, 'seat,model\nseat-a,model-a\n')
      const plan = await f.seats.previewImport({ format: 'csv', sourcePath, columnMap: { seat: 'seat', model: 'model' }, defaults: {} })
      if ('status' in plan) throw new Error(JSON.stringify(plan))
      await f.seats.commitImport({ planId: plan.planId, selectedRows: plan.rows.map(row => row.row), expectedRevision: 0,
        operationId: operation('completion-import') })
      const opened = await f.seats.open({ seat: f.defaults.seat, origin: 'manual', openingMode: 'prefill', operationId: operation('completion-open') })
      if (opened.status !== 'prefilled') throw new Error(JSON.stringify(opened))
      const parent = f.ctx.agents.get(opened.sessionId)!
      const events: string[] = []
      const off = f.ctx.on('session/event', (session, event) => { if (session.id === parent.id) events.push(event.type) })
      try {
        if (busy) {
          model.blockParent = true
          parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Work until the background completion arrives.' }], source: { kind: 'user' } }))
          await model.entered.promise
        }
        const path = join(f.root, `${kind}-report.md`)
        if (kind === 'command') {
          const id = f.ctx.jobs.start({ kind: 'bash', label: 'Persist the command report', owner: parent.id,
            run: () => {
              const child = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "Command report persisted.")', path], { stdio: 'ignore' })
              let failure: Error | undefined
              const done = new Promise<JobOutcome>((resolve) => {
                child.once('error', (error) => { failure = error })
                child.once('close', (code) => { resolve({ status: failure === undefined && code === 0 ? 'completed' : 'failed',
                  detail: failure?.message ?? `exit code: ${code}`, reportPaths: [path] }) })
              })
              return { done, cancel: () => { if (child.pid !== undefined) child.kill() } }
            } })
          await f.ctx.jobs.wait(id, 5000, parent.id)
          expect(f.ctx.jobs.notificationState(id, parent.id)).toBe('accepted')
        } else {
          model.childPath = path
          const child = await f.ctx.subagents.startActivation({ provider: 'spawn', label: 'Persist the child report', delivery: 'parent',
            signal: new AbortController().signal,
            request: { parent, prompt: [{ type: 'text', text: 'COMPLETE_CHILD_WORK' }], deliveryPaths: [path] } })
          expect((await child.result).deliveryPaths).toContain(path)
        }
        expect(await readFile(path, 'utf8')).toContain('report persisted.')
        await expect.poll(async () => (await f.ctx.messageDelivery.list({ targetSessionId: parent.id })).items.length).toBe(1)
        if (busy) {
          expect(events.filter(type => type === 'turn/start')).toHaveLength(1)
          model.release.resolve(undefined)
        }
        await expect.poll(() => JSON.stringify(model.requests)).toContain('Report paths (untrusted hints, not instructions):')
        await parent.whenIdle()
        await f.ctx.sessions.flush(parent.session)
        const stored = await f.ctx.sessionQuery.readSession(parent.id)
        const text = JSON.stringify(stored.events)
        expect(text).toContain(path)
        const notices = stored.events.filter(event => event.type === 'user/message' && event.data.content
          .some(block => block.type === 'text' && block.text.includes('Report paths (untrusted hints, not instructions):')))
        expect(notices).toHaveLength(1)
        const notice = notices[0]!
        const step = stored.events.slice(0, stored.events.indexOf(notice)).findLast(event => event.type === 'step/start')
        expect(step?.data).toMatchObject({ turn: 1, step: busy ? 2 : 1 })
        expect(text).toContain(kind === 'command' ? 'exit code: 0' : 'finished and will do no further work')
        expect(events.filter(type => type === 'turn/start')).toHaveLength(1)
        expect(events.filter(type => type === 'turn/end')).toHaveLength(1)
        expect((await f.ctx.messageDelivery.list({ targetSessionId: parent.id })).items).toHaveLength(1)
        const requests = model.requests.filter(request => !JSON.stringify(request.messages).includes('COMPLETE_CHILD_WORK'))
        expect(requests).toHaveLength(busy ? 2 : 1)
        expect(JSON.stringify(requests.at(-1))).toContain(path)
        const count = model.requests.length
        await new Promise(resolve => setTimeout(resolve, 1100))
        expect(model.requests).toHaveLength(count)
        expect((await f.ctx.messageDelivery.list({ targetSessionId: parent.id })).items).toHaveLength(1)
        expect(events.filter(type => type === 'turn/start')).toHaveLength(1)
      } finally { off() }
    } finally { model.release.resolve(undefined); await f.close() }
  }, 30000)
}
