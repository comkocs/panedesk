/** Registered external sources receive the engine's frozen completion receipts. */
import { createHmac } from 'node:crypto'
import { Context } from '@panedesk/cordis'
import { expect, it } from 'vitest'
import { registerWebhook } from '../src/webhook.ts'
import { receiptFixture } from './receipt-fixture.ts'

it('delivers a signed opened receipt with the frozen ledger payload and idempotency key', async () => {
  const f = await receiptFixture()
  try {
    expect(await f.send()).toBe(202)
    await f.engine.drive()
    await expect.poll(() => f.delivery()?.phase).toBe('delivered')
    const receipt = f.receipts[0]
    if (!receipt) throw new Error('Missing receipt')
    expect(JSON.parse(receipt.body)).toEqual(f.delivery()?.payload)
    expect(f.delivery()?.payload.kind).toBe('opened')
    expect(receipt.headers['idempotency-key']).toBe(f.delivery()?.payload.callbackId)
    expect(receipt.headers['x-seat-source']).toBe(f.source.sourceId)
    expect(receipt.headers['x-seat-key-version']).toBe('current')
    expect(receipt.headers['x-seat-signature']).toBe(createHmac('sha256', f.secret)
      .update(`${receipt.headers['x-seat-timestamp']}.`).update(receipt.body).digest('hex'))
    await f.unload()
    const accepted = [...f.engine.journal.projection.dedup.values()][0]?.trigger
    if (!accepted) throw new Error('Missing ingress')
    expect(await f.engine.accept(accepted)).toMatchObject({ status: 'rejected', error: { code: 'source-not-found' } })
  } finally { await f.close() }
}, 20000)

it('retries a 503 with the same callback identity and records one receiver operation', async () => {
  const f = await receiptFixture()
  try {
    f.state.status = 503
    expect(await f.send()).toBe(202)
    await f.engine.drive()
    await expect.poll(() => f.delivery()?.phase).toBe('retry-due')
    expect(f.delivery()?.responseClass).toBe('transient')
    f.state.status = 204
    await expect.poll(async () => { await f.engine.drive(); return f.delivery()?.phase }).toBe('delivered')
    expect(f.receipts.length).toBeGreaterThanOrEqual(2)
    expect(f.unique.size).toBe(1)
    expect(new Set(f.receipts.map(item => item.body)).size).toBe(1)
    const outcomes = f.engine.journal.projection.decisions.flatMap(item => item.effects)
      .filter(item => item.kind === 'callback/attempted' || item.kind === 'callback/delivered').map(item => item.kind)
    expect(outcomes[0]).toBe('callback/attempted')
    expect(outcomes.at(-1)).toBe('callback/delivered')
  } finally { await f.close() }
}, 20000)

it('pauses a receipt rejected with 401 authentication failure', async () => {
  const f = await receiptFixture()
  try {
    f.state.status = 401
    expect(await f.send()).toBe(202)
    await f.engine.drive()
    await expect.poll(() => f.delivery()?.phase).toBe('paused')
    expect(f.delivery()?.responseClass).toBe('authentication')
    await f.engine.drive()
    expect(f.receipts).toHaveLength(1)
    const payload = f.delivery()?.payload
    if (!payload) throw new Error('Missing callback payload')
    await expect(f.callback(payload)).rejects.toMatchObject({ code: 'callback-authentication-failed', effectState: 'none' })
    expect(f.delivery()?.lastDiagnostic?.cause.effectState).toBe('none')
    expect(await f.engine.nodeStatus()).toMatchObject({ engine: 'running' })
  } finally { await f.close() }
}, 20000)

it('does not follow a 302 redirect and pauses it as a protocol failure', async () => {
  const f = await receiptFixture()
  try {
    f.state.status = 302
    expect(await f.send()).toBe(202)
    await f.engine.drive()
    await expect.poll(() => f.delivery()?.phase).toBe('paused')
    expect(f.delivery()?.responseClass).toBe('protocol')
    expect(f.state.redirected).toBe(0)
  } finally { await f.close() }
}, 20000)

it('aborts a stalled receipt within engine timeout and retains a transient retry', async () => {
  const f = await receiptFixture({ timeoutMs: 100 })
  try {
    f.state.stall = true
    expect(await f.send()).toBe(202)
    const start = performance.now()
    await f.engine.drive()
    await expect.poll(() => f.delivery()?.responseClass).toBe('transient')
    expect(f.delivery()?.phase).toBe('retry-due')
    expect(performance.now() - start).toBeLessThan(3000)
  } finally { await f.close() }
}, 20000)

it('keeps an unconfigured callback local to the engine ledger', async () => {
  const f = await receiptFixture({ callback: false })
  try {
    expect(await f.send()).toBe(202)
    await f.engine.drive()
    await expect.poll(() => f.delivery()?.phase).toBe('delivered')
    expect(f.delivery()?.responseClass).toBe('success')
    expect(f.receipts).toHaveLength(0)
  } finally { await f.close() }
}, 20000)

it('rejects non-HTTP destinations and unregistered signing versions at registration', async () => {
  const ctx = new Context()
  try {
    for (const callback of [{ url: 'file:///receipt', keyVersion: 'current' },
      { url: 'not-a-url', keyVersion: 'current' }, { url: 'https://example.invalid/receipt', keyVersion: 'retired' }]) {
      expect(() => { registerWebhook(ctx, { path: '/seat-events', maxBodyBytes: 1024, maxClockSkewMs: 5000,
        bodyTimeoutMs: 1000, audit: async () => {}, sources: [{ sourceId: 'external-source' as never,
          seat: 'seat-a' as never, projectId: 'project-a' as never, credentialRefs: { current: 'TEST_SOURCE_KEY' }, callback }] }) })
        .toThrow('Invalid external source bounds')
    }
  } finally { await ctx.fiber.dispose() }
})

it('bounds receipt responses and keeps provider secrets, signatures and destinations out of errors and audits', async () => {
  const f = await receiptFixture()
  try {
    f.state.status = 200; f.state.oversized = true
    expect(await f.send()).toBe(202)
    await f.engine.drive()
    await expect.poll(() => f.delivery()?.phase).toBe('paused')
    expect(f.delivery()?.responseClass).toBe('protocol')
    const payload = f.delivery()?.payload
    if (!payload) throw new Error('Missing callback payload')
    f.state.credentialFailure = true
    const failure = await f.callback(payload).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const audit = JSON.stringify(f.engine.journal.projection.decisions) + String(failure)
    for (const value of [f.secret, f.url, String(f.receipts[0]?.headers['x-seat-signature'])]) expect(audit.includes(value)).toBe(false)
    expect(failure).toMatchObject({ message: 'External source callback could not complete' })
  } finally { await f.close() }
}, 20000)
