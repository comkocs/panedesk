import { appendFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import type { InputClaimId, InputTransition } from '@panedesk/dsh-agent/types'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import { ownerFixture } from './fixtures/owner.ts'

const barriers = ['before-claim', 'prepare-suspended', 'appended-before-stream', 'stream-entered'] as const
it.each(barriers)('arbitrates fifty withdrawals at %s without timing sleeps', async (barrier) => {
  for (let iteration = 0; iteration < 50; iteration++) {
    const f = await ownerFixture()
    const reached = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let driver: Promise<void> | undefined
    try {
      await f.send()
      await f.arbitrator.drain()
      const base = { claimId: 'claim-a' as InputClaimId, messageIds: [f.message.messageId], turn: 1, step: 1 }
      const facts: InputTransition['phase'][] = []
      const observe = (transition: InputTransition) => { facts.push(transition.phase); f.arbitrator.observe(transition) }
      const pause = async (stage: typeof barrier) => { if (barrier === stage) { reached.resolve(undefined); await release.promise } }
      driver = (async () => {
        await pause('before-claim')
        await f.arbitrator.drain()
        if (f.queue.length === 0) return
        f.queue.splice(0)
        observe({ ...base, phase: 'claimed' })
        await pause('prepare-suspended')
        observe({ ...base, phase: 'appended', userEventSeqs: [] })
        await pause('appended-before-stream')
        observe({ ...base, phase: 'dispatched', requestId: 'request-a' as Extract<InputTransition, { phase: 'dispatched' }>['requestId'] })
        await pause('stream-entered')
      })()
      void driver.catch((error: unknown) => { reached.reject(error) })
      await reached.promise
      await f.control({ kind: 'withdraw', operationId: 'withdraw-a' as OperationId, expectedRevision: 0 })
      await f.arbitrator.drain()
      const result = await f.result('withdraw-a')
      const successfulWithdrawal = result.kind === 'applied'
      if (barrier === 'before-claim') {
        expect(successfulWithdrawal).toBe(true)
        expect(f.queue).toHaveLength(0)
      } else {
        expect(result).toMatchObject({ kind: 'rejected', reason: barrier === 'stream-entered' ? 'injected' : 'claimed' })
      }
      release.resolve(undefined)
      await driver
      await f.arbitrator.drain()
      const appended = facts.includes('appended')
      const dispatched = facts.includes('dispatched')
      const status = (await f.status()).status
      const row = { barrier, iteration, successfulWithdrawal, appended, dispatched, facts, state: status.state, phase: status.phase }
      expect(successfulWithdrawal && appended).toBe(false)
      expect(successfulWithdrawal && dispatched).toBe(false)
      const output = process.env.MESSAGE_DELIVERY_RACE_LOG
      if (output) await appendFile(output, `${JSON.stringify(row)}\n`, { mode: 0o600 })
    } finally {
      release.resolve(undefined)
      try { await driver } finally { await f.dispose() }
    }
  }
}, 60000)
