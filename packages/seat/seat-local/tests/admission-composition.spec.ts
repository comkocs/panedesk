/** Admission assertions use actual Loader services and observable completion events. */
import { expect, it } from 'vitest'
import { access, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { registerWorktree, taskEnded } from '../../seat-gates/src/worktree-service.ts'
import * as Gates from '../../seat-gates/src/index.ts'
import { join } from 'node:path'
import type { SessionId } from '@panedesk/dsh-session'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'
import { SeatDirectoryChoiceError } from '../src/create-admission.ts'

it('rejects mismatched traditional creation before Session and directory effects', async () => {
  const f = await admissionHost()
  try {
    const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill', operationId: operation('parent') })
    if (opened.status !== 'prefilled') throw new Error('Parent window was not created')
    await f.seats.save({ definition: { ...f.definition,
      directories: [{ path: join(f.options.directory, 'parent-seat'), startup: true }] },
    expectedRevision: 2, operationId: operation('move-parent-root') })
    const otherRoot = join(f.options.directory, 'other-seat')
    const other = { ...f.definition, seat: 'seat-b' as T.SeatName,
      directories: [{ path: otherRoot, startup: true }] }
    await f.seats.save({ definition: other, expectedRevision: 3, operationId: operation('save-other') })
    const cwd = join(otherRoot, 'not-created')
    const id = 'traditional-denied' as SessionId
    const before = (await f.state.read()).watermark
    const parentAgent = f.ctx.agents.get(opened.sessionId)
    if (!parentAgent) throw new Error('Parent window is unavailable')
    await expect(f.ctx.agents.create({ sessionId: id, parentAgent, meta: { cwd } }))
      .rejects.toMatchObject({ name: 'SeatDirectoryChoiceError', result: { status: 'choice-required', candidates: [other.seat],
        choices: ['open-seat', 'traditional', 'cancel'], alternative: `panedesk --profile seat open --seat '${other.seat}'` } })
    expect(f.ctx.agents.get(id)).toBeUndefined()
    expect(await f.ctx.sessionPersistence.stat(id)).toBeUndefined()
    await expect(access(cwd)).rejects.toThrow()
    expect((await f.state.read()).watermark).toBe(before)
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.close() }
})

it('never chooses a shared directory seat and restores explicit free bindings without startup tags', async () => {
  const f = await admissionHost()
  try {
    const other = { ...f.definition, seat: 'seat-b' as T.SeatName }
    await f.seats.save({ definition: other, expectedRevision: 2, operationId: operation('save-b') })
    await expect(f.ctx.agents.create({ sessionId: 'shared-denied' as SessionId, meta: { cwd: f.options.directory } }))
      .rejects.toMatchObject({ result: { status: 'choice-required', candidates: [f.definition.seat, other.seat],
        choices: ['open-seat', 'traditional', 'cancel'],
        alternative: "panedesk --profile seat open --seat 'seat-a' OR panedesk --profile seat open --seat 'seat-b'" } })
    const creation = f.ctx.get('seatLocalCreation')!
    const confirmation = await creation.confirmTraditional(f.options.directory, f.authority)
    const id = 'traditional-free' as SessionId
    f.ctx.provide('ledgerStartupIdentity', { seat: 'startup-seat', window: 'startup-window' })
    const handle = await creation.run(confirmation, f.authority, () => f.ctx.agents.create({ sessionId: id,
      meta: { cwd: f.options.directory } }))
    expect(await f.seats.binding({ sessionId: id })).toMatchObject({ kind: 'free', identitySource: 'free' })
    const runs = (await f.ctx.sessionLedger.query({ sessionId: id })).rows.filter(row => row.kind === 'run')
    expect(runs).toHaveLength(1)
    expect(runs[0]!.start).toMatchObject({ seat: 'free', identitySource: 'free' })
    expect(await f.seats.list({})).toMatchObject({ sessions: [], unopenedSeats: [f.definition.seat, other.seat] })
    await expect(creation.run(confirmation, f.authority, () => f.ctx.agents.create({ sessionId: 'reused-choice' as SessionId,
      meta: { cwd: f.options.directory } }))).rejects.toBeInstanceOf(SeatDirectoryChoiceError)
    await handle.dispose()
    const restored = await f.reload()
    expect(await restored.binding({ sessionId: id })).toMatchObject({ kind: 'free', identitySource: 'free' })
    await expect(creation.confirmTraditional(f.options.directory, f.authority)).rejects.toThrow('unavailable')
  } finally { await f.close() }
})

it('keeps unowned directories free and releases confirmed preparation after setup failure', async () => {
  const f = await admissionHost()
  try {
    await f.seats.save({ definition: { ...f.definition,
      directories: [{ path: join(f.options.directory, 'owned'), startup: true }] },
    expectedRevision: 2, operationId: operation('narrow-root') })
    const id = 'unowned-free' as SessionId
    f.ctx.provide('ledgerStartupIdentity', { seat: 'startup-seat', window: 'startup-window' })
    const handle = await f.ctx.agents.create({ sessionId: id, meta: { cwd: f.options.directory } })
    expect(await f.seats.binding({ sessionId: id })).toMatchObject({ kind: 'free', identitySource: 'free' })
    const rows = (await f.ctx.sessionLedger.query({ sessionId: id })).rows.filter(row => row.kind === 'run')
    expect(rows[0]!.start).toMatchObject({ seat: 'free', identitySource: 'free' })
    await handle.dispose()
    const creation = f.ctx.get('seatLocalCreation')!
    const confirmation = await creation.confirmTraditional(f.options.directory, f.authority)
    const failed = 'failed-free' as SessionId
    await expect(creation.run(confirmation, f.authority, () => f.ctx.agents.create({ sessionId: failed,
      meta: { cwd: f.options.directory }, setup: () => Promise.reject(new Error('setup-failed')) }))).rejects.toThrow('setup-failed')
    expect(f.ctx.sessionLedger.contextFor(failed)).toBeUndefined()
    expect(await f.seats.binding({ sessionId: failed })).toBeNull()
  } finally { await f.close() }
})

it('evaluates batch and single opening gates before engine admission effects', async () => {
  const f = await admissionHost()
  try {
    const calls: T.GateContext[] = []
    f.ctx.loader.builtins.gates = Gates
    const ready = Promise.withResolvers<undefined>()
    f.ctx.inject(['seatGates'], () => { ready.resolve(undefined) })
    await f.load('opening-gates.yml', [{ name: 'cordis:gates', config: { definitions:
      ['before-open', 'before-batch-open'].map(hook => ({ id: hook, name: hook, hook,
        criterion: { type: 'deployment-opening', parameters: {} }, alternative: 'Cancel opening.',
        expiresAt: null, enabled: true, revision: 1, order: -1 })) } }])
    await ready.promise
    const release = f.ctx.get('seatGates')!.register({ id: 'deployment-opening' as T.GateCriterionId,
      evaluate: (context, definition) => {
        calls.push(context)
        return Promise.resolve({ outcome: 'deny', gateId: definition.id, revision: 1, hitCount: 0, expiresAt: null,
          audit: 'recorded', alternative: 'Cancel opening.', reason: { code: 'invalid-request', message: 'Opening blocked.',
            alternative: 'Cancel opening.', retryable: false, effectState: 'none' } })
      } })
    const before = (await f.state.read()).effects
    expect(await f.seats.openBatch({ seats: [f.definition.seat], origin: 'manual', operationId: operation('batch') }))
      .toMatchObject({ status: 'rejected' })
    expect(calls.map(call => call.hook)).toEqual(['before-batch-open'])
    expect(await f.seats.open({ seat: f.definition.seat, origin: 'manual', operationId: operation('single') }))
      .toMatchObject({ status: 'rejected' })
    expect(calls.map(call => call.hook)).toEqual(['before-batch-open', 'before-open'])
    const effects = (await f.state.read()).effects.slice(before.length)
    expect(effects.map(effect => effect.kind)).toEqual(['gate/hit', 'gate/hit'])
    expect(f.adapter.requests).toHaveLength(0)
    release()
  } finally { await f.close() }
})

it('registers production worktree and reminder hosts through Loader', async () => {
  const f = await admissionHost()
  try {
    expect(await f.ctx.get('seatWorktreeHost')!.read()).toEqual({ revision: 0, trees: [] })
    expect(await f.ctx.get('seatWorktreeHost')!.authorize({ registration: { repositoryId: 'missing', path: 'missing',
      seat: f.definition.seat, taskId: 'task-a' as T.SeatTaskId, kind: 'light', branch: 'main', registeredAt: new Date().toISOString() },
    operationId: operation('tree') })).toBe(true)
    const path = join(f.options.directory, 'repository')
    await mkdir(path)
    await promisify(execFile)('git', ['init', '--initial-branch=main', path])
    const registration: T.SeatWorktreeRegistration = { repositoryId: join(path, '.git'), path,
      seat: f.definition.seat, taskId: 'task-a' as T.SeatTaskId, kind: 'client', branch: 'main', registeredAt: new Date().toISOString() }
    expect(await registerWorktree(f.ctx, { registration, operationId: operation('register-tree') }))
      .toMatchObject({ status: 'registered', trees: [registration] })
    expect(await taskEnded(f.ctx, { taskId: registration.taskId, kind: 'settle', sourceId: 'source-a' as T.SeatSourceId,
      operationId: operation('settle-tree') })).toMatchObject({ status: 'observed', trees: [registration] })
    await f.reload()
    expect(await f.ctx.get('seatWorktreeHost')!.read()).toMatchObject({ revision: 1, trees: [registration] })
    expect(f.ctx.get('seatReminderHost')).toBeDefined()
  } finally { await f.close() }
})
