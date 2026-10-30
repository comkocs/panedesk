/** Queued public prompts survive a failed admission query without another sender wake. */
import { expect, it, vi } from 'vitest'
import type { Agent, AgentHandle } from '@panedesk/dsh-agent'
import type { SessionRequestId } from '@panedesk/dsh-api-session-controller'
import { ReactLoopAgent } from '../../../core/agent-loop/src/agent.ts'
import { createUserMessage, type MessageId } from '@panedesk/dsh-llm'
import { LedgerUnavailableError } from '@panedesk/dsh-session-ledger/src/lock.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { composition } from './composition-fixture.ts'
import { auto, sourceId, trigger } from './fixtures.ts'
import { SeatEngine } from '../src/engine.ts'

async function activeSession() {
  const f = await composition(false, { engineConfig: { failureRecovery: { retryInitialMs: 2000 } } })
  f.adapter.finish()
  let handle: AgentHandle | undefined
  try {
    const engine = f.ctx.seatEngine
    if (!(engine instanceof SeatEngine)) throw new Error('Missing production engine')
    engine.registerSource({ sourceId, kinds: ['external'], maxRedeliveryMs: null, callback: async () => {} })
    engine.registerExecutor({ observe: async open => f.ctx.agents.get(open.sessionId) ? 'matching' : 'absent',
      create: async (open) => {
        handle = await f.ctx.agents.create({ sessionId: open.sessionId,
          agentOptions: { provider: 'mock', model: 'model-a' } })
        return handle.agent.id
      }, configure: async () => {}, opening: async () => ({ messageId: 'retained-opening' as MessageId, state: 'completed' }),
      owner: async () => 'alive', wakeSender: async () => 'sent' })
    await auto(engine)
    await engine.accept(trigger())
    await engine.drive()
    if (!handle) throw new Error('Missing active Session')
    const active = handle.agent
    if (!(active instanceof ReactLoopAgent)) throw new Error('Missing production loop agent')
    const controller = createSessionTestController(f.ctx, {
      cwd: f.home, defaultModelSelection: () => ({ provider: 'mock', model: 'model-a' }), nativeOpen: false,
    })
    const prompt = (requestId: string, mode: 'queue' | 'steer' = 'queue') => controller.prompt({
      sessionId: active.id, requestId: requestId as SessionRequestId, mode, content: [{ type: 'text', text: requestId }],
    }, new AbortController().signal)
    expect(engine.journal.projection.opens.get(active.id)?.phase).toBe('active')
    return { ...f, engine, active, handle, prompt }
  } catch (error) { await f.close(); throw error }
}

function turns(agent: Agent) {
  return agent.session.snapshotEvents().filter(event => event.type === 'turn/start')
}

function contention(f: Awaited<ReturnType<typeof activeSession>>, retryable = true) {
  const error = new LedgerUnavailableError(Object.assign(new Error('Writer contention'), retryable
    ? { code: 'EAGAIN', lockTimeoutCode: 'LEDGER_LOCK_TIMEOUT' }
    : { code: 'EIO' }))
  const time = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(time)
  const snapshot = vi.spyOn(f.ctx.sessionLedger, 'snapshot').mockRejectedValue(error)
  const errors: unknown[] = []
  f.ctx.on('agent/error', ({ error }) => { errors.push(error) })
  return { error, errors, snapshot, clock, time }
}

it('starts exactly one retained queued prompt after complete recovery, never during backoff', async () => {
  const f = await activeSession()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const lock = contention(f)
    expect(await f.prompt('retained queued prompt')).toEqual({ accepted: true })
    await f.active.whenIdle()
    expect(lock.errors).toContain(lock.error)
    expect(f.active.inbox.nextTurn).toHaveLength(1)
    await expect.poll(async () => (await f.engine.nodeStatus()).failure, { timeout: 5000 })
      .toMatchObject({ code: 'LEDGER_LOCK_TIMEOUT', retryable: true })
    lock.snapshot.mockRestore()
    lock.clock.mockReturnValue(lock.time + 1999)
    await f.engine.drive()
    expect(turns(f.active)).toHaveLength(0)
    lock.clock.mockReturnValue(lock.time + 2000)
    await f.engine.drive()
    expect((await f.engine.nodeStatus()).failure).toBeUndefined()
    await f.active.whenIdle()
    expect(turns(f.active)).toHaveLength(1)
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.active.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === 'retained queued prompt')).toHaveLength(1)
    expect(f.active.inbox.hasPending).toBe(false)
    await f.engine.drive()
    await f.engine.drive()
    expect(turns(f.active)).toHaveLength(1)
  } finally { vi.restoreAllMocks(); await f.close() }
}, 20000)

it('coalesces concurrent steering prompts into one recovered turn and consumes both once', async () => {
  const f = await activeSession()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const lock = contention(f)
    expect(await Promise.all([f.prompt('first retained steer', 'steer'), f.prompt('second retained steer', 'steer')]))
      .toEqual([{ accepted: true }, { accepted: true }])
    await f.active.whenIdle()
    expect(f.active.inbox.nextStep).toHaveLength(2)
    await expect.poll(async () => (await f.engine.nodeStatus()).failure, { timeout: 5000 })
      .toMatchObject({ code: 'LEDGER_LOCK_TIMEOUT', retryable: true })
    lock.snapshot.mockRestore()
    lock.clock.mockReturnValue(lock.time + 2000)
    await Promise.all([f.engine.drive(), f.engine.drive()])
    await f.active.whenIdle()
    expect(turns(f.active)).toHaveLength(1)
    expect(f.adapter.requests).toHaveLength(1)
    const consumed = f.active.session.snapshotEvents().flatMap(event => event.type === 'user/message'
      && event.data.source.kind === 'user' && 'rpcId' in event.data.source ? [event.data.source.rpcId] : [])
    expect(consumed).toEqual(['first retained steer', 'second retained steer'])
    expect(f.active.inbox.hasPending).toBe(false)
    await f.engine.drive()
    expect(turns(f.active)).toHaveLength(1)
  } finally { vi.restoreAllMocks(); await f.close() }
}, 20000)

it('does not drive passive input when the ledger recovers', async () => {
  const f = await activeSession()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const lock = contention(f)
    f.active.enqueue(createUserMessage({ content: [{ type: 'text', text: 'Passive notice' }], source: { kind: 'user' } }),
      { priority: 'queue', passive: true, wakeup: true })
    await expect.poll(async () => (await f.engine.nodeStatus()).failure, { timeout: 5000 })
      .toMatchObject({ retryable: true })
    lock.snapshot.mockRestore()
    lock.clock.mockReturnValue(lock.time + 2000)
    await f.engine.drive()
    expect((await f.engine.nodeStatus()).failure).toBeUndefined()
    await f.active.whenIdle()
    expect(turns(f.active)).toHaveLength(0)
    expect(f.adapter.requests).toHaveLength(0)
    expect(f.active.inbox.nextTurn).toHaveLength(1)
  } finally { vi.restoreAllMocks(); await f.close() }
}, 20000)

it('keeps a nonretryable admission failure stopped without waking retained input', async () => {
  const f = await activeSession()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const lock = contention(f, false)
    expect(await f.prompt('retained after permanent failure')).toEqual({ accepted: true })
    await f.active.whenIdle()
    expect(lock.errors).toContain(lock.error)
    await expect.poll(async () => (await f.engine.nodeStatus()).failure, { timeout: 5000 })
      .toMatchObject({ retryable: false })
    lock.snapshot.mockRestore()
    lock.clock.mockReturnValue(lock.time + 300000)
    await f.engine.drive()
    await f.active.whenIdle()
    expect((await f.engine.nodeStatus()).engine).toBe('unavailable')
    expect(turns(f.active)).toHaveLength(0)
    expect(f.adapter.requests).toHaveLength(0)
    expect(f.active.inbox.nextTurn).toHaveLength(1)
  } finally { vi.restoreAllMocks(); await f.close() }
}, 20000)

it('cancels retained input on disposal instead of replaying it after recovery', async () => {
  const f = await activeSession()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const lock = contention(f)
    expect(await f.prompt('cancel on shutdown')).toEqual({ accepted: true })
    await f.active.whenIdle()
    await expect.poll(async () => (await f.engine.nodeStatus()).failure, { timeout: 5000 })
      .toMatchObject({ retryable: true })
    await f.handle.dispose()
    expect(f.active.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
      && event.data.outcome === 'canceled')).toHaveLength(1)
    lock.snapshot.mockRestore()
    lock.clock.mockReturnValue(lock.time + 2000)
    await f.engine.drive()
    expect(turns(f.active)).toHaveLength(0)
    expect(f.adapter.requests).toHaveLength(0)
    expect(f.ctx.agents.get(f.active.id)).toBeUndefined()
  } finally { vi.restoreAllMocks(); await f.close() }
}, 20000)
