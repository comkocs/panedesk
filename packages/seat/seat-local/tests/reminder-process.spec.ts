/** Separate Loader processes replay the original close reminder after a crash. */
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

function host(root: string, phase: string) {
  const child = fork(fileURLToPath(new URL('./reminder-process-worker.ts', import.meta.url)), [root, phase], {
    execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/.test(key))),
      TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.json') },
  })
  const pid = child.pid
  const received = Promise.withResolvers<Record<string, unknown>>()
  let errors = ''
  child.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString() })
  child.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'kind' in message) received.resolve(message)
  })
  child.on('exit', () => { received.reject(new Error(`Reminder worker exited: ${errors}`)) })
  const timer = setTimeout(() => { received.reject(new Error(`Reminder worker timed out: ${errors}`)) }, 15000)
  return { child, pid, ready: received.promise.finally(() => { clearTimeout(timer) }) }
}
async function kill(child: ChildProcess, pid: number | undefined) {
  if (child.pid !== pid) throw new Error('Reminder worker identity changed')
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}
it.each(['pending', 'sent'])('recovers one close reminder after SIGKILL at %s', async (phase) => {
  const root = await mkdtemp(join(process.cwd(), '.seat-reminder-process-'))
  const children: ReturnType<typeof host>[] = []
  try {
    const first = host(root, phase); children.push(first)
    expect(first.pid).toBeTypeOf('number')
    expect(await first.ready).toMatchObject({ kind: 'barrier', pid: first.pid })
    await kill(first.child, first.pid)
    const recovered = host(root, 'recover'); children.push(recovered)
    const result = await recovered.ready
    expect(result).toMatchObject({ kind: 'recovered', copies: 1, pid: recovered.pid })
    expect(result.milliseconds).toBeLessThan(5000)
    process.stdout.write(`${JSON.stringify({ phase, ...result })}\n`)
    const exited = once(recovered.child, 'exit')
    recovered.child.send('stop')
    expect(await exited).toEqual([0, null])
  } finally {
    for (const child of children) await kill(child.child, child.pid)
    await rm(root, { recursive: true, force: true })
  }
}, 40000)
