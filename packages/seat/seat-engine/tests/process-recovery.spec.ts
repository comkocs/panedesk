import { expect, it } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const stages = ['before-ingress', 'ingress', 'intent', 'creating', 'materialized', 'created',
  'configured-workspace', 'configured-model', 'configured-permission', 'configured-subscriptions',
  'configured-title', 'configured-binding', 'opening-accepted', 'first-turn-running', 'active',
  'closing-archived', 'callback-accepted', 'release'] as const
function start(home: string, stage: string) {
  const child = fork(fileURLToPath(new URL('./process-worker.ts', import.meta.url)), [home, stage], {
    execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/.test(key))),
  })
  let output = ''
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const exited = once(child, 'exit')
  const ready = new Promise<void>((resolve, reject) => {
    child.on('message', (message: unknown) => {
      if (message && typeof message === 'object' && 'stage' in message && message.stage === stage) resolve()
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => { reject(new Error(`Child exited before barrier: ${code}/${signal}: ${output}`)) })
  })
  return { child, exited, ready, output: () => output }
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}
it.each(stages)('A09 recovers the original durable identity after SIGKILL at %s', async (stage) => {
  const home = await mkdtemp(join(tmpdir(), 'seat-engine-process-'))
  const children: ChildProcess[] = []
  try {
    const first = start(home, stage); children.push(first.child)
    expect(first.child.pid).toBeTypeOf('number')
    await first.ready
    first.child.kill('SIGKILL')
    expect(await first.exited).toEqual([null, 'SIGKILL'])
    const recovery = start(home, 'none'); children.push(recovery.child)
    // Only the first child has a kill barrier; recovery must exit on its own.
    void recovery.ready.catch(() => {})
    expect(await recovery.exited, recovery.output()).toEqual([0, null])
    const result: {
      physical: string[]
      sessionId: string
      operationId: string
      phase: string
      pending: number
      resources: number
      messages: string[]
      callbacks: string[]
      callbackStates: string[]
    } =
      JSON.parse(await readFile(join(home, 'result.json'), 'utf8')) as typeof result
    expect(result.physical).toEqual([result.sessionId])
    expect(result.messages).toEqual([`message-${result.operationId}`])
    expect(result.phase).toBe('active')
    expect(result.pending).toBe(0)
    const closed = stage === 'closing-archived' || stage === 'release'
    expect(result.resources).toBe(closed ? 0 : 1)
    expect(result.callbacks).toHaveLength(closed ? 2 : 1)
    expect(result.callbackStates.every(value => value === 'delivered')).toBe(true)
  } finally {
    for (const child of children) await stop(child)
    await rm(home, { recursive: true, force: true })
  }
}, 20000)
