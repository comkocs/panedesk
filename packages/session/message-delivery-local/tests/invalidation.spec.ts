import { afterEach, describe, expect, it } from 'vitest'
import type { InputClaimId, InputTransition } from '@panedesk/dsh-agent/types'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import { ownerFixture } from './fixtures/owner.ts'

const fixtures: Awaited<ReturnType<typeof ownerFixture>>[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(item => item.dispose())) })
async function setup() { const f = await ownerFixture(); fixtures.push(f); await f.send(); await f.arbitrator.drain(); return f }
function dispatched(f: Awaited<ReturnType<typeof ownerFixture>>): InputTransition {
  return { phase: 'dispatched', claimId: 'claim-a' as InputClaimId, messageIds: [f.message.messageId], turn: 1, step: 1,
    requestId: 'request-a' as Extract<InputTransition, { phase: 'dispatched' }>['requestId'] }
}

describe('invalidation and response attribution', () => {
  it('排队作废等同撤回，已认领作废拒绝且不创建通知', async () => {
    const queued = await setup()
    await queued.control({ kind: 'invalidate', operationId: 'invalidate-a' as OperationId, expectedRevision: 0 }, { reason: '取消' })
    await queued.arbitrator.drain()
    expect((await queued.status()).status.state).toBe('withdrawn')
    expect((await queued.status()).notification).toBeUndefined()
    expect(queued.queue).toHaveLength(0)
    const claimed = await setup()
    claimed.queue.splice(0)
    claimed.arbitrator.observe({ phase: 'claimed', claimId: 'claim-a' as InputClaimId, messageIds: [claimed.message.messageId], turn: 1, step: 1 })
    await claimed.control({ kind: 'invalidate', operationId: 'invalidate-a' as OperationId, expectedRevision: 0 }, { reason: '取消' })
    await claimed.arbitrator.drain()
    expect(await claimed.result('invalidate-a')).toMatchObject({ kind: 'rejected', reason: 'claimed' })
    expect((await claimed.status()).notification).toBeUndefined()
  })

  it('已回应作废原子保存新号通知，重复重放不重复入队', async () => {
    const f = await setup()
    f.queue.splice(0)
    f.arbitrator.observe(dispatched(f))
    f.arbitrator.assistant(1)
    await f.arbitrator.finish(1, true)
    expect((await f.status()).status.state).toBe('responded')
    await f.control({ kind: 'invalidate', operationId: 'invalidate-a' as OperationId, expectedRevision: 0 }, { reason: '失效' })
    await f.arbitrator.drain()
    const decision = await f.status()
    expect(decision.status.state).toBe('invalidated')
    expect(decision.notification?.messageId).not.toBe(f.message.messageId)
    await f.arbitrator.drain()
    expect(f.queue).toHaveLength(1)
    await f.restart()
    expect(f.queue).toHaveLength(1)
    expect(f.queue[0]).toMatchObject({ id: decision.notification?.messageId, source: { relatedMessageId: f.message.messageId } })
  })
  it('atomically retains invalidation and one notification across replay', async () => {
    const f = await setup()
    f.queue.splice(0)
    f.arbitrator.observe(dispatched(f))
    await f.arbitrator.drain()
    await f.control({ kind: 'invalidate', operationId: 'invalidate-a' as OperationId, expectedRevision: 0 }, { reason: 'superseded' })
    await f.arbitrator.drain()
    const decision = await f.status()
    expect(decision.status.state).toBe('invalidated')
    expect(decision.notification?.messageId).not.toBe(f.message.messageId)
    expect(decision.notification?.priority).toBe('steer')
    expect(decision.notification?.content).toContain('superseded')
    await f.removeReceipt('invalidate-a')
    await f.restart()
    expect((await f.result('invalidate-a')).kind).toBe('applied')
    expect((await f.status()).notification?.messageId).toBe(decision.notification?.messageId)
    expect(f.queue).toHaveLength(1)
  })

  it('retains first injection and responds only on a successful containing request', async () => {
    const f = await setup()
    f.queue.splice(0)
    f.arbitrator.observe(dispatched(f))
    await f.arbitrator.drain()
    const first = (await f.status()).status.transitions.find(event => event.data.transition === 'injected')
    f.arbitrator.assistant(1)
    await f.arbitrator.finish(1, false)
    f.arbitrator.request(2, [])
    f.arbitrator.assistant(2)
    await f.arbitrator.finish(2, true)
    expect((await f.status()).status.state).toBe('injected')
    f.arbitrator.request(3, [f.message.messageId])
    await f.arbitrator.finish(3, true)
    expect((await f.status()).status.state).toBe('injected')
    f.arbitrator.request(4, [f.message.messageId])
    f.arbitrator.assistant(4)
    await f.arbitrator.finish(4, true)
    const status = (await f.status()).status
    expect(status.state).toBe('responded')
    expect(status.transitions.filter(event => event.data.transition === 'injected')).toEqual([first])
  })

  it('restores appended claims without rolling back or enqueueing duplicate text', async () => {
    const f = await setup()
    f.queue.splice(0)
    const transition: InputTransition = { phase: 'appended', claimId: 'claim-a' as InputClaimId,
      messageIds: [f.message.messageId], turn: 1, step: 1, userEventSeqs: [] }
    await f.restart([transition])
    expect(f.queue).toHaveLength(0)
    expect((await f.status()).status.phase).toBe('appended')
    await f.control({ kind: 'withdraw', operationId: 'withdraw-a' as OperationId, expectedRevision: 0 })
    await f.arbitrator.drain()
    expect(await f.result('withdraw-a')).toMatchObject({ kind: 'rejected', reason: 'claimed' })
  })
})
