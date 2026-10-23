/** Real Loader children retain opening identity across committed SIGKILL barriers. */
import { expect, it } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function host(root: string, stage: string, route?: string) {
  const child = fork(fileURLToPath(new URL('./open-recovery-worker.ts', import.meta.url)), [root, stage, ...route ? [route] : []], {
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
  const ready = received.promise.finally(() => { clearTimeout(timer) })
  return { child, pid, ready }
}
async function kill(child: ChildProcess, pid: number | undefined) {
  if (child.pid !== pid) throw new Error('Worker identity changed')
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}
it.each(['open/intent', 'open/created', 'open/configured'])(
  'recovers a Loader opening after SIGKILL at %s without duplicate input or admission', async (stage) => {
    const root = await mkdtemp(join(process.cwd(), '.seat-open-recovery-'))
    const children: ReturnType<typeof host>[] = []
    try {
      const first = host(root, stage); children.push(first)
      expect(first.pid).toBeTypeOf('number')
      expect(await first.ready).toMatchObject({ kind: 'barrier', pid: first.pid })
      await kill(first.child, first.pid)
      const recovered = host(root, 'recover'); children.push(recovered)
      const result = await recovered.ready
      expect(result).toMatchObject({ kind: 'recovered', opens: 1, sessions: 1, messages: 1, accepted: 1 })
      expect(result.milliseconds).toBeLessThanOrEqual(5000)
      process.stdout.write(`${JSON.stringify({ stage, ...result })}\n`)
      const exited = once(recovered.child, 'exit')
      recovered.child.send('stop')
      expect(await exited).toEqual([0, null])
    } finally {
      for (const child of children) await kill(child.child, child.pid)
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

it('uses the frozen model for the first resumed turn after the catalog model changes', async () => {
  const root = await mkdtemp(join(process.cwd(), '.seat-open-route-'))
  const children: ReturnType<typeof host>[] = []
  try {
    const first = host(root, 'open/created', 'frozen-route'); children.push(first)
    expect(await first.ready).toMatchObject({ kind: 'barrier', pid: first.pid })
    await kill(first.child, first.pid)
    const recovered = host(root, 'recover', 'frozen-route'); children.push(recovered)
    const result = await recovered.ready
    expect(result).toMatchObject({ kind: 'recovered', opens: 1, sessions: 1, messages: 1, accepted: 1, requests: 1,
      frozenModel: 'model-b', currentModel: 'model-c', permission: 'permission-a',
      firstRoute: { provider: 'provider-a', model: 'model-b', reasoningEffort: 'effort-a' } })
    expect(result.milliseconds).toBeLessThanOrEqual(5000)
    process.stdout.write(`${JSON.stringify({ stage: 'frozen-route', ...result })}\n`)
    const exited = once(recovered.child, 'exit')
    recovered.child.send('stop')
    expect(await exited).toEqual([0, null])
  } finally {
    for (const child of children) await kill(child.child, child.pid)
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
