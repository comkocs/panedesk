/** An unconsumed opening can be withdrawn only after its original owner is fenced. */
import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { resolveExampleLaunch } from '@panedesk/dsh-loader-smoke'
import type * as T from '@panedesk/dsh-seat'
import { SEAT_ERROR_CODES } from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { digest } from '../src/store.ts'
import { localFact } from '../src/engine-state.ts'

type Host = Awaited<ReturnType<typeof admissionHost>>
async function restartHost(root: string): Promise<Host> {
  const host = await admissionHost(root)
  // engineFixture constructs SeatEngine directly; install its production turn-admission hook.
  host.ctx.on('agent/turn-admitting', async ({ agent }, next) => {
    const upstream = await next()
    if (upstream.kind !== 'allow') return upstream
    const admission = await host.engine.admitTurn(agent.id)
    return admission.status === 'allow' ? upstream : { kind: 'defer', reason: admission.reason }
  })
  return host
}
const reference: T.OpeningContextReference = { providerId: 'restart-provider' as T.OpeningProviderId,
  reference: 'restart-task' as T.OpeningContextReference['reference'], revision: '1' }
function registerCallbacks(host: Host, received: T.SeatCallbackPayload[]) {
  return host.ctx.get('seatOpeningContexts')!.register({ providerId: reference.providerId,
    resolve: async () => ({ reference, text: 'Retained opening', digest: digest('Retained opening'),
      revision: '1', taskIds: [], scopeEvidence: [] }),
    callback: async (payload) => { received.push(payload) } })
}
async function snapshot(host: Host) {
  const listed = await host.seats.list({})
  if (listed.status !== 'listed' || !listed.sessions[0]) throw new Error(JSON.stringify(listed))
  return listed.sessions[0]
}
async function closeCurrent(host: Host, sessionId: T.EngineOpenData['sessionId']) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await snapshot(host)
    const result = await host.seats.close({ sessionId, expectedStateVersion: current.stateVersion,
      operationId: operation(`restart-close-${attempt}`) })
    if (result.status !== 'conflict') return result
  }
  throw new Error('Close never acquired the current revision')
}

it('automatically closes an orphaned queued opening and never replays it after another restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seat-orphaned-opening-'))
  let host: Host | undefined
  const received: T.SeatCallbackPayload[] = []
  try {
    host = await restartHost(root)
    registerCallbacks(host, received)
    host.ctx.on('agent/turn-admitting', () => ({ kind: 'defer', reason: 'Restart before consuming the opening.' }))
    const opened = await host.ctx.get('seatOpeningContexts')!.open({ seat: host.definition.seat,
      origin: 'manual', openingMode: 'auto', operationId: operation('orphaned-opening'), openingContext: reference,
      relatedTaskIds: [] }, host.authority)
    if (opened.status !== 'opened') throw new Error(JSON.stringify(opened))
    const open = host.engine.journal.projection.opens.get(opened.sessionId)!
    const messageId = open.openingMessageId!
    expect(messageId).toBeTruthy()
    expect(await host.ctx.messageDelivery.status(messageId)).toMatchObject({ state: 'queued' })
    expect(host.adapter.requests).toHaveLength(0)
    await host.ctx.sessions.flush(host.ctx.agents.get(opened.sessionId)!.session)
    await host.close()
    host = undefined
    host = await restartHost(root)
    registerCallbacks(host, received)
    await host.engine.drive()
    expect(host.engine.journal.projection.resources.has(opened.sessionId)).toBe(false)
    expect(await host.engine.admitTurn(opened.sessionId)).toEqual({ status: 'defer', reason: 'owner-unknown' })
    await vi.waitFor(async () => {
      await host!.engine.drive()
      expect(received.map(payload => payload.kind)).toEqual(['opened', 'opening-failed', 'window-ended'])
    })
    const failed = received.find(payload => payload.kind === 'opening-failed')!
    expect(failed).toMatchObject({ reason: { code: 'opening-failed', effectState: 'partial', retryable: false,
      message: 'The host restarted after opening; its previous owner is dead and the first turn was never executed.',
      cause: { domain: 'seat-local', code: 'opening-owner-lost', operationId: open.openingOperationId,
        nodeId: open.binding.nodeId, effectState: 'partial', retryable: false } } })
    if (failed.kind !== 'opening-failed') throw new Error('Missing opening failure')
    // Mirror the private projection's safe seat-domain predicate; it never reads message.
    const cause = failed.reason.cause
    const visible = cause && ['seat-engine', 'seat-local', 'node-link', 'node-work-chain'].includes(cause.domain)
      && Object.hasOwn(SEAT_ERROR_CODES, cause.code) ? `${cause.domain}/${cause.code}` : `rejected/${failed.reason.code}`
    expect(visible).toBe('seat-local/opening-owner-lost')
    expect(failed.stateVersion).toBeGreaterThan(received[0]!.stateVersion)
    const recovered = (await host.state.read()).effects
    expect(recovered.filter(effect => effect.kind === 'open/opening-failed')).toHaveLength(1)
    expect(recovered.some(effect => effect.kind === 'open/created')).toBe(true)
    expect(recovered.some(effect => effect.kind === 'resource/reserved')).toBe(true)
    await host.close(); host = undefined
    host = await restartHost(root)
    registerCallbacks(host, received)
    await host.engine.drive()
    expect(received.filter(payload => payload.kind === 'opening-failed')).toEqual([failed])
    expect((await host.state.read()).effects.filter(effect => effect.kind === 'open/opening-failed')).toHaveLength(1)
    expect(host.engine.journal.projection.closed.get(opened.sessionId)).toMatchObject({ reason: 'owner-dead' })
    expect(await host.ctx.messageDelivery.status(messageId)).toMatchObject({ state: 'withdrawn' })
    expect(host.ctx.workspaceRegistry.archivedSessionIds).toContain(opened.sessionId)
    await vi.waitFor(async () => {
      await host!.engine.drive()
      expect(received.filter(payload => payload.kind === 'window-ended')).toHaveLength(1)
    }, { timeout: 10000 })
    expect((await host.state.read()).effects.filter(effect => effect.kind === 'window/closed')).toHaveLength(1)
    expect(host.adapter.requests).toHaveLength(0)
    await host.close()
    host = undefined
    host = await restartHost(root)
    registerCallbacks(host, received)
    await host.engine.drive()
    expect(await host.ctx.messageDelivery.status(messageId)).toMatchObject({ state: 'withdrawn' })
    expect(host.engine.journal.projection.closed.has(opened.sessionId)).toBe(true)
    expect((await host.state.read()).effects.filter(effect => effect.kind === 'window/closed')).toHaveLength(1)
    expect(await host.seats.close({ sessionId: opened.sessionId, expectedStateVersion: 0,
      operationId: operation('closed-replay') })).toMatchObject({ status: 'closed' })
    await host.engine.drive()
    expect(received.filter(payload => payload.kind === 'window-ended')).toHaveLength(1)
    expect(received.find(payload => payload.kind === 'window-ended')).toMatchObject({ reason: 'owner-dead' })
    expect(received.filter(payload => payload.kind === 'opening-failed')).toHaveLength(1)
    expect((await host.state.read()).effects.filter(effect => effect.kind === 'open/opening-failed')).toHaveLength(1)
    expect(host.ctx.agents.get(opened.sessionId)).toBeUndefined()
    expect(host.adapter.requests).toHaveLength(0)
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)

it.each(['responded', 'unknown-owner'] as const)(
  'does not mislabel or withdraw an opening with %s evidence after restart', async (boundary) => {
    const root = await mkdtemp(join(tmpdir(), 'seat-orphaned-control-'))
    let host: Host | undefined
    const received: T.SeatCallbackPayload[] = []
    try {
      host = await restartHost(root)
      registerCallbacks(host, received)
      if (boundary !== 'responded') host.ctx.on('agent/turn-admitting', () => ({ kind: 'defer', reason: 'Hold the opening.' }))
      const opened = await host.ctx.get('seatOpeningContexts')!.open({ seat: host.definition.seat, origin: 'manual',
        openingMode: 'auto', operationId: operation(`control-${boundary}`), openingContext: reference, relatedTaskIds: [] }, host.authority)
      if (opened.status !== 'opened') throw new Error(JSON.stringify(opened))
      const messageId = host.engine.journal.projection.opens.get(opened.sessionId)!.openingMessageId!
      if (boundary === 'responded') await vi.waitFor(async () => {
        expect((await host!.ctx.sessionQuery.readSession(opened.sessionId)).events.some(event => event.type === 'turn/end')).toBe(true)
      })
      await host.ctx.sessions.flush(host.ctx.agents.get(opened.sessionId)!.session)
      await host.close(); host = undefined
      host = await restartHost(root)
      registerCallbacks(host, received)
      const delivery = host.ctx.messageDelivery
      expect(await delivery.status(messageId)).toMatchObject({ state: boundary === 'responded' ? 'responded' : 'queued' })
      if (boundary === 'unknown-owner') {
        const query = host.ctx.sessionLedger.query.bind(host.ctx.sessionLedger)
        vi.spyOn(host.ctx.sessionLedger, 'query').mockImplementation(async request => ({ ...await query(request), complete: false }))
      }
      const withdraw = vi.spyOn(delivery, 'withdraw')
      await host.engine.drive()
      expect((await host.state.read()).effects.filter(effect => effect.kind === 'open/opening-failed')).toHaveLength(0)
      expect(received.filter(payload => payload.kind === 'opening-failed')).toHaveLength(0)
      if (boundary === 'unknown-owner') expect(host.engine.journal.projection.resources.has(opened.sessionId)).toBe(true)
      const result = await closeCurrent(host, opened.sessionId)
      if (boundary === 'responded') expect(result.status).toBe('closed')
      else {
        expect(result.status).toBe('busy')
        expect(host.ctx.workspaceRegistry.archivedSessionIds).not.toContain(opened.sessionId)
      }
      expect(withdraw).not.toHaveBeenCalled()
      expect(host.adapter.requests).toHaveLength(0)
    } finally { await host?.close(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) }
  }, 30000)

it.each(['claimed', 'injected'] as const)('retains real %s opening evidence across process death without withdrawal or replay', async (boundary) => {
  const root = await mkdtemp(join(tmpdir(), 'seat-orphaned-real-input-'))
  let host: Host | undefined, child: ChildProcess | undefined
  const received: T.SeatCallbackPayload[] = []
  try {
    const script = fileURLToPath(new URL('./orphaned-opening-process-worker.ts', import.meta.url))
    const launch = resolveExampleLaunch({ srcBin: script, libBin: script, mode: 'src',
      tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)), configArgs: [root, boundary] })
    const env = Object.fromEntries(Object.entries({ ...process.env, ...launch.env })
      .filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
    child = spawn(launch.command, launch.args, { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const exited = once(child, 'exit')
    let diagnostics = ''
    child.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString() })
    const barrier = await new Promise<unknown>((resolve, reject) => {
      child!.once('message', resolve)
      child!.once('error', reject)
      child!.once('exit', (code, signal) => { reject(new Error(`Input worker exited: ${code}/${signal}: ${diagnostics}`)) })
    })
    expect(barrier).toMatchObject({ kind: 'input-boundary', pid: child.pid, boundary,
      status: boundary === 'claimed' ? { state: 'queued', phase: 'claimed' } : { state: 'injected', phase: 'dispatched' },
      withdrawal: { kind: 'rejected', reason: boundary }, liveClose: { status: 'busy' },
      userMessages: boundary === 'claimed' ? 0 : 1 })
    if (!barrier || typeof barrier !== 'object' || !('received' in barrier) || !Array.isArray(barrier.received)
      || !('phases' in barrier) || !Array.isArray(barrier.phases)) {
      throw new Error('Missing worker callbacks or input phases')
    }
    expect(barrier.phases).toContain(boundary === 'claimed' ? 'claimed' : 'dispatched')
    received.push(...barrier.received as T.SeatCallbackPayload[])
    console.info(`Input boundary ${boundary}: recorded child PID=${child.pid}`)
    child.kill('SIGKILL')
    expect(await exited).toEqual([null, 'SIGKILL'])
    host = await restartHost(root)
    registerCallbacks(host, received)
    const open = [...host.engine.journal.projection.opens.values()][0]!
    const messageId = open.openingMessageId!
    expect(await host.ctx.messageDelivery.status(messageId)).toMatchObject(boundary === 'claimed'
      ? { state: 'queued', phase: 'claimed' } : { state: 'injected', phase: 'dispatched' })
    const withdraw = vi.spyOn(host.ctx.messageDelivery, 'withdraw')
    await host.engine.drive()
    expect(host.engine.journal.projection.resources.has(open.sessionId)).toBe(false)
    expect((await host.state.read()).effects.filter(effect => effect.kind === 'open/opening-failed')).toHaveLength(0)
    const result = await closeCurrent(host, open.sessionId)
    // Live work was busy before death; cold recovery has no runnable pending input and uses ordinary idle-close rules.
    expect(result.status).toBe('closed')
    expect(withdraw).not.toHaveBeenCalled()
    expect(await host.ctx.messageDelivery.status(messageId)).not.toMatchObject({ state: 'withdrawn' })
    expect(received.filter(payload => payload.kind === 'opening-failed')).toHaveLength(0)
    expect(host.adapter.requests).toHaveLength(0)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    }
    await host?.close(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true })
  }
}, 30000)

it('replays an older already-released opening without a failure and records the missing diagnosis once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seat-legacy-orphan-'))
  let host: Host | undefined
  const received: T.SeatCallbackPayload[] = []
  try {
    host = await restartHost(root)
    registerCallbacks(host, received)
    host.ctx.on('agent/turn-admitting', () => ({ kind: 'defer', reason: 'Legacy queued opening.' }))
    const opened = await host.ctx.get('seatOpeningContexts')!.open({ seat: host.definition.seat, origin: 'manual',
      openingMode: 'auto', operationId: operation('legacy-orphan'), openingContext: reference, relatedTaskIds: [] }, host.authority)
    if (opened.status !== 'opened') throw new Error(JSON.stringify(opened))
    await host.ctx.sessions.flush(host.ctx.agents.get(opened.sessionId)!.session)
    // Replay fixture matching the pre-fix durable release, not a production resource deletion.
    const resource = host.engine.journal.projection.resources.get(opened.sessionId)!
    await host.state.mutate(() => ({ result: undefined, effects: [localFact({ kind: 'resource/released',
      sessionId: opened.sessionId, data: { owner: resource.owner, reason: 'host-restart-recovery',
        observedAt: new Date().toISOString(), releasedAt: new Date().toISOString(),
        engineReadyAt: new Date().toISOString(), fenced: true } })] }))
    expect((await host.state.read()).effects.some(effect => effect.kind === 'open/opening-failed')).toBe(false)
    await host.close(); host = undefined
    host = await restartHost(root)
    registerCallbacks(host, received)
    await vi.waitFor(async () => {
      await host!.engine.drive()
      expect(received.filter(payload => payload.kind === 'opening-failed')).toHaveLength(1)
    })
    expect((await host.state.read()).effects.filter(effect => effect.kind === 'open/opening-failed')).toHaveLength(1)
    expect(await closeCurrent(host, opened.sessionId)).toMatchObject({ status: 'closed' })
    expect(host.adapter.requests).toHaveLength(0)
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)
