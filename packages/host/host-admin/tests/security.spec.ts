/** Private-file ownership, durable admission and browser exclusion regressions. */
import { afterEach, expect, test } from 'vitest'
import { mkdtemp, rm, chmod, symlink, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:http'
import { randomBytes } from 'node:crypto'
import { PosixPrivateFiles } from '../src/private-files.ts'
import { OperationStore } from '../src/operation-store.ts'
import { digest } from '../src/json.ts'
import { callLoopback, listenLoopback } from '../src/loopback.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function directory() {
  const root = await mkdtemp(join(process.env.TEST_RESOURCE_ROOT ?? tmpdir(), 'admin-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}
const limits = { maxFrameBytes: 4096, requestTimeoutMs: 1000, maxPending: 8 }

test('rejects permissive files, foreign owners, links and duplicate owners', async () => {
  const root = await directory(), files = new PosixPrivateFiles(root, process.getuid!())
  await files.write('credential', randomBytes(32).toString('hex'))
  expect((await files.read('credential', 64))?.length).toBe(64)
  const release = await files.lock()
  await expect(files.lock()).rejects.toThrow()
  await release()
  await chmod(join(root, 'credential'), 0o644)
  await expect(files.read('credential', 64)).rejects.toThrow('permissions')
  await chmod(join(root, 'credential'), 0o600)
  await expect(new PosixPrivateFiles(root, process.getuid!() + 1).read('credential', 64)).rejects.toThrow('ownership')
  await symlink(join(root, 'credential'), join(root, 'linked'))
  await expect(files.read('linked', 64)).rejects.toThrow()
  await expect(files.write('linked', 'replacement')).rejects.toThrow()
  await chmod(root, 0o755)
  await expect(files.read('credential', 64)).rejects.toThrow('permissions')
  await chmod(root, 0o700)
})

test('persists duplicate results and refuses pending replay after recovery', async () => {
  const files = new PosixPrivateFiles(await directory(), process.getuid!())
  const store = new OperationStore(files, 4096, 10)
  await store.load()
  let calls = 0
  const execute = async () => ({ count: ++calls })
  const results = await Promise.all([store.run('operation-a', digest({ a: 1 }), execute), store.run('operation-a', digest({ a: 1 }), execute)])
  expect(results).toEqual([{ state: 'settled', result: { count: 1 } }, { state: 'settled', result: { count: 1 } }])
  expect(await store.run('operation-a', digest({ a: 2 }), execute)).toEqual({ state: 'conflict' })
  expect(await store.run('operation-b', digest({}), async () => { throw new Error('interrupted') })).toEqual({ state: 'pending' })
  const recovered = new OperationStore(files, 4096, 10)
  await recovered.load()
  expect(await recovered.run('operation-b', digest({}), execute)).toEqual({ state: 'pending' })
  expect(calls).toBe(1)
  expect(recovered.hasPending).toBe(true)
  expect(await recovered.reconcile('operation-b', digest({}), async () => ({ state: 'settled', result: 'receipt' })))
    .toEqual({ state: 'settled', result: 'receipt' })
  expect(recovered.hasPending).toBe(false)
})

test('accepts authenticated loopback JSON and refuses stale epochs and browser headers', async () => {
  const auth = { credential: randomBytes(32).toString('hex'), epoch: 'epoch-a' }
  let calls = 0
  const listener = await listenLoopback(0, limits, () => auth, async (value) => { calls++; return value })
  cleanups.push(() => listener.close())
  expect(await callLoopback(listener.port, auth, { value: 1 }, limits)).toEqual({ value: 1 })
  await expect(callLoopback(listener.port, { ...auth, epoch: 'old' }, {}, limits)).rejects.toThrow()
  await expect(callLoopback(listener.port, { ...auth, credential: randomBytes(32).toString('hex') }, {}, limits)).rejects.toThrow()
  const raw = (headers: Record<string, string>, path = '/rpc') => new Promise<number | undefined>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: listener.port, path, method: 'POST', headers: {
      'content-type': 'application/json', authorization: auth.credential, 'x-rpc-epoch': auth.epoch, ...headers,
    } }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject); req.end('{}')
  })
  expect(await raw({ origin: 'https://browser.invalid' })).toBe(403)
  expect(await raw({ cookie: 'browser=value' })).toBe(403)
  expect(await raw({ host: 'browser.invalid' })).toBe(403)
  expect(await raw({}, '/rpc?credential=forbidden')).toBe(403)
  expect(calls).toBe(1)
})

test('keeps channel values out of durable operation records', async () => {
  const root = await directory(), files = new PosixPrivateFiles(root, process.getuid!())
  const credential = randomBytes(32).toString('hex')
  await files.write('credential', credential)
  const store = new OperationStore(files, 4096, 10)
  await store.load(); await store.run('operation-a', digest({ action: 'approve' }), async () => ({ status: 'approved' }))
  expect((await readFile(join(root, 'operations.json'), 'utf8')).includes(credential)).toBe(false)
})
