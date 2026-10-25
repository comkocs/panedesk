/** Complete seat and engine processes recover committed input, never a torn frozen admission. */
import { expect, test } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolveExampleLaunch } from '@panedesk/dsh-loader-smoke'
import { methods } from './frozen-process-fixture.ts'

function worker(root: string, method: string, stage: string) {
  const script = fileURLToPath(new URL('./frozen-process-worker.ts', import.meta.url))
  const launch = resolveExampleLaunch({ srcBin: script, libBin: script, mode: 'lib', configArgs: [root, method, stage] })
  const env = Object.fromEntries(Object.entries({ ...process.env, ...launch.env })
    .filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
  const child = spawn(launch.command, launch.args, { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const exited = once(child, 'exit')
  let diagnostics = ''
  child.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString() })
  const message = new Promise<unknown>((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
    child.once('exit', (code, signal) => { reject(new Error(`Worker exited before response: ${code}/${signal}: ${diagnostics}`)) })
  })
  return { child, exited, message, diagnostics: () => diagnostics }
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

test.each(methods)('%s queries the original result after full process SIGKILL and restart', async (method) => {
  const root = await mkdtemp(join(tmpdir(), 'frozen-process-')), children: ChildProcess[] = []
  try {
    const first = worker(root, method, 'write'); children.push(first.child)
    expect(first.child.pid).toBeTypeOf('number')
    const accepted = await first.message
    expect(accepted).toMatchObject({ kind: 'accepted', before: { status: 'pending', effectState: 'unknown' },
      result: { status: method === 'engine.acceptFrozen' ? 'accepted' : method === 'seat.openFrozen' ? 'queued' : 'opened' } })
    await kill(first.child)
    expect(await first.exited).toEqual([null, 'SIGKILL'])
    const second = worker(root, method, 'recover'); children.push(second.child)
    const recovered = await second.message
    expect(await second.exited, second.diagnostics()).toEqual([0, null])
    if (!accepted || typeof accepted !== 'object' || !('result' in accepted)) throw new Error('Expected admission result')
    expect(recovered).toMatchObject({ kind: 'recovered', before: { status: 'pending', effectState: 'unknown' },
      result: { status: 'settled', method, result: accepted.result }, routes: 1,
      conflict: { status: 'rejected', error: { code: 'operation-id-conflict' } },
      variants: Array.from({ length: 4 }, () => ({ status: 'missing' })) })
  } finally { for (const child of children) await kill(child); await rm(root, { recursive: true, force: true }) }
}, 20000)

test.each(methods)('%s recovers no partial admission after SIGKILL during the durable write', async (method) => {
  const root = await mkdtemp(join(tmpdir(), 'frozen-torn-')), children: ChildProcess[] = []
  try {
    const first = worker(root, method, 'partial'); children.push(first.child)
    expect(await first.message).toEqual({ kind: 'partial', pid: first.child.pid })
    await kill(first.child)
    expect(await first.exited).toEqual([null, 'SIGKILL'])
    const second = worker(root, method, 'recover'); children.push(second.child)
    expect(await second.message).toMatchObject({ kind: 'recovered', before: { status: 'pending', effectState: 'unknown' },
      result: { status: 'missing' }, routes: 0 })
    expect(await second.exited, second.diagnostics()).toEqual([0, null])
  } finally { for (const child of children) await kill(child); await rm(root, { recursive: true, force: true }) }
}, 20000)
