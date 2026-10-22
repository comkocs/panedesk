import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@panedesk/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import Ledger, { JournalSessionLedger } from '../src/index.ts'
import { runStart } from './fixtures.ts'

const homes: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})
describe('runtime ledger context', () => {
  it('registers the journal provider and owns bindings independently of durable attribution', async () => {
    const home = await mkdtemp(join(import.meta.dirname, '.context-'))
    homes.push(home)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Ledger, { dshHome: home })
    expect(ctx.sessionLedger).toBeInstanceOf(JournalSessionLedger)
    const ledger = ctx.sessionLedger
    await ledger.beginRun(runStart)
    const first = { ...runStart, seat: 'seat-b' }
    const releaseFirst = ledger.bindContext(first)
    first.seat = 'mutated'
    const releaseSecond = ledger.bindContext({ ...runStart, seat: 'seat-c' })
    const request = { sessionId: runStart.sessionId, provider: 'provider-a', model: 'model-a' }
    expect(await ledger.resolveCallContext(request)).toMatchObject({ context: { seat: 'seat-c' }, runId: runStart.runId })
    releaseFirst(); releaseFirst()
    expect(ledger.contextFor(runStart.sessionId)?.seat).toBe('seat-c')
    releaseSecond()
    expect(ledger.contextFor(runStart.sessionId)).toBeUndefined()
    expect(await ledger.resolveCallContext(request)).toMatchObject({ context: { seat: 'seat-a' }, runId: runStart.runId })
    const unknown = await ledger.resolveCallContext({ provider: 'provider-a', model: 'model-a' })
    expect(unknown).toMatchObject({ context: { sessionId: 'unknown', rootSessionId: 'unknown', accountLabel: 'unknown' }, runId: 'unknown' })
    expect(unknown.price).toBeUndefined()
  })
})
