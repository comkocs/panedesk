import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@panedesk/cordis'
import type { InputClaimId, InputTransition } from '@panedesk/dsh-agent'
import { ToolCallId } from '@panedesk/dsh-llm'
import { SessionId } from '@panedesk/dsh-session'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLongTool, createProcessFixture, createTestClocks, createTestGate,
  createWatchControl, createWriteFault, mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness, mountInputBarriers,
} from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  return { ctx, harness: await mountAgentLoopTestHarness(ctx) }
}

describe('deterministic scenario controls', () => {
  it('releases explicit gates and removes cancelled waiters', async () => {
    const gate = createTestGate()
    const controller = new AbortController()
    const waiting = gate.wait(controller.signal)
    await gate.reached
    controller.abort(new Error('cancelled'))
    await expect(waiting).rejects.toThrow('cancelled')
    gate.release()
    await gate.wait()
    await expect(gate.wait(controller.signal)).rejects.toThrow('cancelled')
  })

  it('keeps wall jumps separate from monotonic elapsed time', () => {
    const clock = createTestClocks(1000, 10)
    clock.advance(5)
    clock.setWall(900)
    expect([clock.wallNow(), clock.monotonicNow()]).toEqual([900, 15])
    expect(() => { clock.advance(-1) }).toThrow()
    expect(() => { clock.setWall(Infinity) }).toThrow()
    expect(() => createTestClocks(NaN, 0)).toThrow()
  })

  it('drops disabled watch events and disposes the real registration once', () => {
    let changed = (): void => {}
    let notifications = 0
    let disposals = 0
    const watch = createWatchControl((notify) => {
      changed = notify
      return () => { disposals += 1 }
    }, () => { notifications += 1 })
    changed()
    watch.disable()
    changed()
    watch.enable()
    changed()
    watch.close()
    watch.close()
    watch.enable()
    changed()
    expect([notifications, disposals]).toEqual([2, 1])
  })

  it('injects one failed write without invoking or replacing real disk operations', async () => {
    const fault = createWriteFault()
    let writes = 0
    const write = async (): Promise<number> => ++writes
    fault.failAfter(1, 'ENOSPC')
    expect(await fault.run(write)).toBe(1)
    await expect(fault.run(write)).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(await fault.run(write)).toBe(2)
    expect(() => { fault.failAfter(-1, 'EIO') }).toThrow()
  })

  it('drives four checkpoints with declared events and isolates parent and child channels', async () => {
    const { ctx, harness: driver } = await harness()
    const parent = await driver.create(SessionId('seat-a'))
    const child = await driver.create(SessionId('seat-b'))
    const hits: string[] = []
    const barriers = mountInputBarriers(ctx, parent, (point) => { hits.push(point) })
    const childBarriers = mountInputBarriers(ctx, child)
    const signal = new AbortController().signal
    const before = ctx.serial('agent/input-preparing', { agent: parent, turn: 1, step: 1, signal })
    await barriers.beforePrepare.reached
    barriers.beforePrepare.release()
    await before
    const transition = { claimId: 'claim-a' as InputClaimId, messageIds: [], turn: 1, step: 1 }
    parent.session.append('agent/input/transition', { ...transition, phase: 'claimed' })
    await barriers.claimedPrepare.reached
    const preparing = ctx.waterfall('agent/request', { agent: parent, turn: 1, step: 1, signal },
      async () => ({ provider: 'mock', model: 'model-a' }))
    barriers.claimedPrepare.release()
    await preparing
    parent.session.append('agent/input/transition', { ...transition, phase: 'appended', userEventSeqs: [] })
    await barriers.appended.reached
    const appended = barriers.appended.wait()
    barriers.appended.release()
    await appended
    const dispatched: Extract<InputTransition, { phase: 'dispatched' }> = {
      ...transition, phase: 'dispatched',
      requestId: 'request-a' as Extract<InputTransition, { phase: 'dispatched' }>['requestId'],
    }
    ctx.emit('agent/input-dispatching', { agent: parent, transition: dispatched })
    await barriers.streamEntered.reached
    expect(hits).toEqual(['appended', 'streamEntered'])
    let childEntered = false
    void childBarriers.streamEntered.reached.then(() => { childEntered = true })
    await Promise.resolve()
    expect(childEntered).toBe(false)
    barriers.dispose()
    childBarriers.dispose()
    ctx.emit('agent/input-dispatching', { agent: parent, transition: dispatched })
    expect(hits).toHaveLength(2)
  })

  it.each([true, false])('runs a real long tool with cooperative=%s and preserves partial cancellation output', async (cooperative) => {
    const { ctx } = await harness()
    const tool = createLongTool('controlled_tool', cooperative)
    const unregister = ctx.tools.register(tool.definition)
    const controller = new AbortController()
    const result = ctx.tools.execute({
      signal: controller.signal, callId: ToolCallId('call-a'), name: 'controlled_tool', arguments: {},
    })
    try {
      const call = await tool.nextCall()
      call.emit('partial output')
      controller.abort()
      await call.abortObserved
      if (!cooperative) {
        let settled = false
        void result.then(() => { settled = true })
        await Promise.resolve()
        expect(settled).toBe(false)
        call.finish('late output')
      }
      const outcome = await result
      expect(outcome.isError).toBe(true)
      expect(outcome.content).toContainEqual({ type: 'text', text: 'partial output' })
    } finally {
      tool.dispose()
      await result
      unregister()
    }
  })

  it('runs independent tool invocations through one real registry', async () => {
    const { ctx } = await harness()
    const tool = createLongTool('independent_tool', false)
    const unregister = ctx.tools.register(tool.definition)
    const signal = new AbortController().signal
    const first = ctx.tools.execute({ signal, callId: ToolCallId('parent-call'), name: 'independent_tool', arguments: {} })
    const second = ctx.tools.execute({ signal, callId: ToolCallId('child-call'), name: 'independent_tool', arguments: {} })
    try {
      const parent = await tool.nextCall()
      const child = await tool.nextCall()
      parent.finish('parent')
      child.finish('child')
      expect((await first).content).toEqual([{ type: 'text', text: 'parent' }])
      expect((await second).content).toEqual([{ type: 'text', text: 'child' }])
    } finally {
      tool.dispose()
      await Promise.all([first, second])
      unregister()
    }
  })

  it('crashes and reopens owned real processes with the same private disk state', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'testkit-process-'))
    const fixture = await createProcessFixture(parent)
    const state = join(fixture.root, 'state.txt')
    const code = 'const fs = require("node:fs"); fs.appendFileSync(process.argv[1], "generation\\n"); console.log("ready"); setInterval(() => {}, 1000)'
    try {
      const first = await fixture.start(process.execPath, ['-e', code, state], 'ready', 5000)
      expect(first.pid).toBeGreaterThan(0)
      expect((await first.crash()).signal).toBe('SIGKILL')
      const second = await fixture.start(process.execPath, ['-e', code, state], 'ready', 5000)
      expect(second.pid).not.toBe(first.pid)
      expect(await readFile(state, 'utf8')).toBe('generation\ngeneration\n')
      const fault = createWriteFault()
      fault.failAfter(0, 'EIO')
      await expect(fault.run(() => writeFile(state, 'lost'))).rejects.toMatchObject({ code: 'EIO' })
      expect(await readFile(state, 'utf8')).toBe('generation\ngeneration\n')
      await second.crash()
      await expect(fixture.start(process.execPath, ['-e', 'process.exit(1)'], 'ready', 5000)).rejects.toThrow('before readiness')
      await expect(fixture.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 'ready', 20)).rejects.toThrow('timed out')
    } finally {
      await fixture.dispose()
      await rm(parent, { recursive: true, force: true })
    }
    await expect(readFile(state)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
