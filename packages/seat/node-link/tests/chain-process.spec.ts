/** Independent processes exercise isolated stores and original-intent recovery after exit. */
import { afterEach, expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function worker(directory: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./chain-process-worker.ts', import.meta.url)), directory],
    { stdio: ['pipe', 'pipe', 'pipe'], env })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  let stopped = false
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const close = async () => {
    if (stopped) return
    stopped = true
    child.stdin.end('close\n')
    await exited
  }
  cleanups.push(close)
  expect((await lines.next()).value).toBe('ready')
  return { pid: child.pid, close, call: async (command: string) => {
    child.stdin.write(`${command}\n`)
    const line = await lines.next()
    if (line.done) throw new Error('Chain worker exited before response')
    return line.value
  } }
}

test('two processes retain separate original intents and recover pending records without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chain-process-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const a = join(root, 'a'), b = join(root, 'b')
  await mkdir(a, { mode: 0o700 }); await mkdir(b, { mode: 0o700 })
  const first = await worker(a), second = await worker(b)
  expect(first.pid).not.toBe(second.pid)
  expect(JSON.parse(await first.call('admit'))).toEqual({ state: 'admitted' })
  expect(JSON.parse(await second.call('query'))).toEqual({ state: 'missing' })
  expect(JSON.parse(await first.call('admit'))).toEqual({ state: 'pending' })
  await first.close()
  const restarted = await worker(a)
  expect(restarted.pid).not.toBe(first.pid)
  expect(JSON.parse(await restarted.call('query'))).toEqual({ state: 'pending' })
  expect(await restarted.call('settle')).toBe('settled')
  expect(JSON.parse(await restarted.call('query'))).toMatchObject({ state: 'settled' })
  expect(JSON.parse(await second.call('query'))).toEqual({ state: 'missing' })
}, 20000)
