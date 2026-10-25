/** Full sender restart reconciles original callback identity at both durable crash windows. */
import { expect, test } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function worker(home: string, stage: string) {
  const child = fork(fileURLToPath(new URL('./routed-callback-process-worker.ts', import.meta.url)), [home, stage], {
    execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key))) })
  const exited = once(child, 'exit')
  let diagnostics = ''
  child.stderr?.on('data', (chunk: Buffer) => { diagnostics += chunk.toString() })
  const message = new Promise<unknown>((resolve, reject) => {
    child.once('message', resolve); child.once('error', reject)
    child.once('exit', (code, signal) => { reject(new Error(`Worker exited before response: ${code}/${signal}: ${diagnostics}`)) })
  })
  return { child, exited, message, diagnostics: () => diagnostics }
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
}
test.each(['intent', 'sent'])('recovers one same-key owner write after SIGKILL at %s', async (stage) => {
  const home = await mkdtemp(join(tmpdir(), 'routed-callback-process-')), children: ChildProcess[] = []
  try {
    const first = worker(home, stage); children.push(first.child)
    expect(first.child.pid).toBeTypeOf('number')
    const before = await first.message
    expect(before).toMatchObject({ stage, pid: first.child.pid })
    await kill(first.child)
    expect(await first.exited).toEqual([null, 'SIGKILL'])
    const next = worker(home, 'recover'); children.push(next.child)
    const result = await next.message
    expect(await next.exited, next.diagnostics()).toEqual([0, null])
    if (!before || typeof before !== 'object' || !('body' in before)) throw new Error('Missing original callback')
    expect(result).toMatchObject({ stage: 'recovered', body: before.body, owner: before.body, phase: 'delivered',
      inputs: stage === 'sent' ? ['chain.operation'] : ['chain.operation', 'source.deliverCallback'] })
  } finally { for (const child of children) await kill(child); await rm(home, { recursive: true, force: true }) }
}, 20000)
