/** Two independent Loader processes exchange evidence and recover original intents over real node-link HTTP. */
import { afterEach, expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PosixPrivateFiles, object, parseJson } from '@panedesk/dsh-host-admin'
import { networkPair } from './chain-network-host.ts'
import { networkInput } from './chain-network-fixture.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const request = (operation: string, size = 1) => ({ kind: 'route',
  ...networkInput(operation, new Date(Date.now() + 60000).toISOString(), size) })
type Worker = Awaited<ReturnType<Awaited<ReturnType<typeof networkPair>>['start']>>
async function connected(worker: Worker, chain = true) {
  await expect.poll(async () => {
    const value = await worker.call({ kind: 'status' })
    if (!object(value) || !Array.isArray(value.status) || !object(value.status[0])) return false
    return value.status[0].reachable === true && Array.isArray(value.status[0].capabilities)
      && value.status[0].capabilities.includes('node-work-chain/v1') === chain
  }, { timeout: 10000 }).toBe(true)
}
async function state(worker: Worker) { return worker.call({ kind: 'status' }) }

test('isolated peers fetch retained evidence, bound frames, replay once, expire and reject an old peer', async () => {
  const pair = await networkPair(); cleanups.push(pair.close)
  const a = await pair.start(0), b = await pair.start(1)
  expect(a.pid).not.toBe(b.pid)
  await connected(a); await connected(b)
  const first = request('network-once')
  // Recovery queries have separate coverage and must not race this exact evidence count.
  await a.call({ kind: 'fault', value: 'pause-recovery' })
  expect(await a.call(first)).toMatchObject({ status: 'ok', result: { status: 'prepared' } })
  expect(await a.call(first)).toMatchObject({ status: 'ok', result: { status: 'prepared' } })
  expect(await state(b)).toMatchObject({ executions: 1, evidenceChecks: 1 })
  const retained = parseJson(await readFile(join(a.directory, 'chain-evidence/evidence-v1.json'), 'utf8'), 1048576)
  expect(object(retained) && object(retained.entries) && Object.keys(retained.entries).length).toBe(1)
  await expect(readFile(join(b.directory, 'chain-evidence/evidence-v1.json'))).rejects.toThrow()
  expect(await a.call(request('too-large', 1000))).toMatchObject({ error: { cause: { reasonCode: 'frame-too-large' } } })
  const expired = { kind: 'route', ...networkInput('expired', '2000-01-01T00:00:00.000Z') }
  expect(await a.call(expired)).toMatchObject({ status: 'rejected', error: { effectState: 'none' } })
  expect(await state(b)).toMatchObject({ executions: 1, evidenceChecks: 1 })
  await b.close()
  const files = new PosixPrivateFiles(b.directory, process.getuid!())
  const settings = parseJson((await files.read('worker.json', 65536))!, 65536)
  if (!object(settings)) throw new Error('Worker settings missing')
  await files.write('worker.json', JSON.stringify({ ...settings, chain: false }))
  const legacy = await pair.start(1)
  await connected(a, false)
  expect(await a.call(request('old-peer'))).toMatchObject({ error: { cause: { reasonCode: 'peer-capability-missing' } } })
  expect(await state(legacy)).toMatchObject({ executions: 1, evidenceChecks: 0 })
}, 30000)

test.each(['sender', 'receiver'] as const)('recovers after %s restart and a lost response without executing the original key twice', async (side) => {
  const pair = await networkPair(); cleanups.push(pair.close)
  let a = await pair.start(0), b = await pair.start(1)
  await connected(a); await connected(b)
  await b.call({ kind: 'fault', value: 'after-business' })
  const original = request(`restart-${side}`)
  expect(await a.call(original)).toMatchObject({ status: 'uncertain', error: { effectState: 'unknown' } })
  expect(await state(b)).toMatchObject({ executions: 1, held: true })
  if (side === 'sender') {
    await a.close(); await b.call({ kind: 'release' }); a = await pair.start(0)
  } else {
    await b.close(true)
    // A crashed lock owner requires explicit test-owner confirmation, never runtime takeover.
    const files = new PosixPrivateFiles(b.directory, process.getuid!())
    await files.remove('owner.lock')
    b = await pair.start(1)
  }
  await connected(a); await connected(b)
  await expect.poll(() => a.call(original), { timeout: 10000 }).toMatchObject({ status: 'ok', result: { status: 'prepared' } })
  expect(await state(b)).toMatchObject({ executions: 1 })
}, 30000)

test('interrupted recovery resends only the durable original method, key and digest after business reports missing', async () => {
  const pair = await networkPair(); cleanups.push(pair.close)
  let a = await pair.start(0), b = await pair.start(1)
  await connected(a); await connected(b)
  await b.call({ kind: 'fault', value: 'before-business' })
  const original = request('missing-replay')
  expect(await a.call(original)).toMatchObject({ status: 'uncertain' })
  expect(await state(b)).toMatchObject({ executions: 0, held: true })
  await a.close(); await b.close(true)
  const files = new PosixPrivateFiles(b.directory, process.getuid!())
  await files.remove('owner.lock')
  b = await pair.start(1)
  await b.call({ kind: 'fault', value: 'during-query' })
  a = await pair.start(0)
  await expect.poll(() => state(b), { timeout: 10000 }).toMatchObject({ executions: 0, held: true })
  await a.close(true)
  await new PosixPrivateFiles(a.directory, process.getuid!()).remove('owner.lock')
  await b.call({ kind: 'release' })
  a = await pair.start(0)
  await connected(a); await connected(b)
  await expect.poll(() => a.call(original), { timeout: 10000 }).toMatchObject({ status: 'ok', result: { status: 'prepared' } })
  const sent = parseJson(await readFile(join(a.directory, 'chain-sent/chain-v1.json'), 'utf8'), 1048576)
  if (!object(sent) || !object(sent.entries)) throw new Error('Sender store missing')
  expect(Object.values(sent.entries)).toHaveLength(1)
  expect(Object.values(sent.entries)[0]).toMatchObject({ request: original.request })
  expect(await state(b)).toMatchObject({ executions: 1 })
}, 30000)
