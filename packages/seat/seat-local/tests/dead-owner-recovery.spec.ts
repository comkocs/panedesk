/** Real owner death must release an acknowledged opening instead of resuming its residency. */
import { expect, it } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function host(root: string, stage: string) {
  const child = fork(fileURLToPath(new URL('./dead-owner-recovery-worker.ts', import.meta.url)), [root, stage], {
    execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/.test(key))),
  })
  const pid = child.pid
  const received = Promise.withResolvers<Record<string, unknown>>()
  let errors = ''
  child.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString() })
  child.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'kind' in message) received.resolve(message)
  })
  child.on('exit', () => { received.reject(new Error(`Worker exited: ${errors}`)) })
  const timer = setTimeout(() => { received.reject(new Error(`Worker timed out: ${errors}`)) }, 15000)
  return { child, pid, ready: received.promise.finally(() => { clearTimeout(timer) }) }
}
async function kill(child: ChildProcess, pid: number | undefined) {
  if (child.pid !== pid) throw new Error('Worker identity changed')
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}
it('A16 releases an acknowledged opening after host SIGKILL and completes its exclusive waiter within five seconds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seat-dead-owner-'))
  const children: ReturnType<typeof host>[] = []
  try {
    const first = host(root, 'held'); children.push(first)
    const held = await first.ready
    expect(held).toMatchObject({ kind: 'held', pid: first.pid, phase: 'opening-pending' })
    await kill(first.child, first.pid)
    const recovered = host(root, 'recover'); children.push(recovered)
    const result = await recovered.ready
    expect(result).toMatchObject({ kind: 'released', opens: 2, sessions: 2, agents: 2, pending: 0,
      releases: [{ reason: 'host-restart-recovery', fenced: true, owner: { sessionId: held.sessionId } }],
      closed: [{ sessionId: held.sessionId, reason: 'owner-dead' }], archived: [held.sessionId], requests: 1 })
    expect(result.milliseconds).toBeLessThanOrEqual(5000)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    const exited = once(recovered.child, 'exit')
    recovered.child.send('stop')
    expect(await exited).toEqual([0, null])
  } finally {
    for (const child of children) await kill(child.child, child.pid)
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
