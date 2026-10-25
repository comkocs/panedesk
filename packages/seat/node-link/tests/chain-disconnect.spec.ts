/** Real peer processes distinguish unsent refusals from interrupted, query-only recovery. */
import { afterEach, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PosixPrivateFiles, object, parseJson } from '@panedesk/dsh-host-admin'
import { networkPair } from './chain-network-host.ts'
import { networkInput } from './chain-network-fixture.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
type Worker = Awaited<ReturnType<Awaited<ReturnType<typeof networkPair>>['start']>>
async function sent(worker: Worker) {
  const value = parseJson(await readFile(join(worker.directory, 'chain-sent/chain-v1.json'), 'utf8'), 1048576)
  if (!object(value) || !object(value.entries)) throw new Error('Sending records unavailable')
  return Object.values(value.entries)
}
async function connect(a: Worker, b: Worker) {
  await expect.poll(async () => {
    await a.call({ kind: 'handshake' })
    await b.call({ kind: 'handshake' })
    const status = await a.call({ kind: 'status' })
    return object(status) && Array.isArray(status.status) && object(status.status[0])
      && Array.isArray(status.status[0].capabilities) && status.status[0].capabilities.includes('node-work-chain/v1')
  }, { timeout: 10000 }).toBe(true)
}

for (const iteration of [1, 2, 3, 4, 5]) {
  test(`closed peer listener settles an unsent refusal and withdraws routing, run ${iteration}`, async () => {
    const pair = await networkPair(60000); cleanups.push(pair.close)
    const a = await pair.start(0), b = await pair.start(1)
    await connect(a, b)
    await a.call({ kind: 'fault', value: 'pause-recovery' })
    await b.close()
    const input = networkInput(`unsent-${iteration}`, new Date(Date.now() + 60000).toISOString())
    const started = performance.now()
    const response = await a.call({ kind: 'route', ...input })
    const elapsedMs = performance.now() - started
    expect(response).toMatchObject({ status: 'unavailable', error: { code: 'node-tunnel-disconnected',
      reason: 'tunnel-disconnected', effectState: 'none' } })
    expect(await sent(a)).toEqual([expect.objectContaining({ request: input.request, response })])
    expect(await a.call({ kind: 'query', ...input })).toMatchObject({ method: 'chain.operation',
      status: 'unavailable', error: object(response) ? response.error : undefined })
    const status = await a.call({ kind: 'status' })
    expect(status).toMatchObject({ status: [{ reachable: false,
      linkState: 'disconnected', safeReason: 'node-tunnel-disconnected' }] })
    if (!object(status) || !Array.isArray(status.status) || !object(status.status[0])) throw new Error('Node status unavailable')
    expect(status.status[0].capabilities).not.toContain('node-work-chain/v1')
    const next = networkInput(`offline-${iteration}`, new Date(Date.now() + 60000).toISOString())
    expect(await a.call({ kind: 'route', ...next })).toMatchObject({ error: { code: 'node-tunnel-disconnected', effectState: 'none' } })
    expect(await sent(a)).toHaveLength(1)
    console.info(JSON.stringify({ scenario: 'unsent', iteration, status: 'unavailable', code: 'node-tunnel-disconnected',
      effectState: 'none', store: 'settled', elapsedMs: Number(elapsedMs.toFixed(3)) }))
  }, 30000)

  test(`peer loss after business execution stays unknown until one exact query, run ${iteration}`, async () => {
    const pair = await networkPair(60000); cleanups.push(pair.close)
    const a = await pair.start(0)
    let b = await pair.start(1)
    await connect(a, b)
    await a.call({ kind: 'fault', value: 'pause-recovery' })
    await b.call({ kind: 'fault', value: 'after-business' })
    const input = networkInput(`interrupted-${iteration}`, new Date(Date.now() + 60000).toISOString())
    const started = performance.now()
    const pending = a.call({ kind: 'route', ...input })
    await expect.poll(() => b.call({ kind: 'status' }), { interval: 5 }).toMatchObject({ executions: 1, held: true })
    await b.close(true)
    expect(await pending).toMatchObject({ status: 'uncertain', error: { code: 'node-outcome-unknown', effectState: 'unknown' } })
    const elapsedMs = performance.now() - started
    expect(await sent(a)).toEqual([{ request: input.request }])
    expect(await a.call({ kind: 'query', ...input })).toMatchObject({ status: 'uncertain',
      error: { code: 'node-outcome-unknown', effectState: 'unknown' } })
    expect(await sent(a)).toEqual([{ request: input.request }])
    expect(await a.call({ kind: 'query', ...input })).toMatchObject({ status: 'uncertain',
      error: { code: 'node-outcome-unknown', effectState: 'unknown' } })
    expect(await sent(a)).toEqual([{ request: input.request }])
    await new PosixPrivateFiles(b.directory, process.getuid!()).remove('owner.lock')
    b = await pair.start(1)
    await connect(a, b)
    const queryStarted = performance.now()
    expect(await a.call({ kind: 'query', ...input })).toMatchObject({ status: 'ok', method: 'chain.operation',
      result: { status: 'settled', method: 'source.prepareOpening', result: { status: 'prepared' } } })
    const queryElapsedMs = performance.now() - queryStarted
    const entries = await sent(a)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ request: input.request, response: { status: 'ok', result: { status: 'prepared' } } })
    expect(await a.call({ kind: 'route', ...input })).toMatchObject({ status: 'ok', result: { status: 'prepared' } })
    expect(await b.call({ kind: 'status' })).toMatchObject({ executions: 1, evidenceChecks: 1, queries: 1 })
    console.info(JSON.stringify({ scenario: 'interrupted', iteration, status: 'uncertain', code: 'node-outcome-unknown',
      effectState: 'unknown', store: 'pending-to-settled', executions: 1, queries: 1,
      elapsedMs: Number(elapsedMs.toFixed(3)), queryElapsedMs: Number(queryElapsedMs.toFixed(3)) }))
  }, 30000)
}
