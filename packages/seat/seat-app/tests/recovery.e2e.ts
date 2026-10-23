/** Supplements engine process-recovery.spec.ts with real M5 and concurrent exact create. */
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

function start(home: string, stage: string) {
  const child = fork(fileURLToPath(new URL('./fixtures/e2e-recovery-worker.ts', import.meta.url)), [home, stage], {
    execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD/.test(name))),
  })
  const exited = once(child, 'exit')
  const messages: { stage: string; pid: number; sessionId?: string; error?: string }[] = []
  let stderr = ''
  child.stderr!.on('data', (data: Buffer) => { stderr += data.toString() })
  child.on('message', (message) => { messages.push(message as typeof messages[number]) })
  const wait = async (names: string[]) => {
    await expect.poll(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(stderr)
      return messages.find(message => names.includes(message.stage))
    }, { timeout: 15000 }).toBeDefined().catch((error: unknown) => {
      throw new Error(`Barrier ${names.join(',')} was not reached: ${stderr}`, { cause: error })
    })
    return messages.find(message => names.includes(message.stage))!
  }
  console.info(JSON.stringify({ stage, pid: child.pid }))
  return { child, exited, wait, stderr: () => stderr }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

it.each(['m5-accepted', 'first-turn'])('recovers real delivery after SIGKILL at %s without replaying unknown effects', async (stage) => {
  const home = await mkdtemp(join(process.env.PANEDESK_HOME ?? process.cwd(), 'seat-recovery-'))
  const children: ChildProcess[] = []
  try {
    const first = start(home, stage); children.push(first.child)
    const barrier = await first.wait([stage])
    expect(barrier.pid).toBe(first.child.pid)
    first.child.kill('SIGKILL')
    expect(await first.exited).toEqual([null, 'SIGKILL'])
    const restored = start(home, `recover-${stage}`); children.push(restored.child)
    expect(await restored.exited, restored.stderr()).toEqual([0, null])
    const result = JSON.parse(await readFile(join(home, 'recovered.json'), 'utf8')) as {
      accepted: { messageId: string; deliveryOutcome: string }
      duplicate: { messageId: string }
      sessions: string[]
      events: { type: string; data: object }[]
      requests: number
      effects: string
    }
    expect(result.sessions).toEqual(['seat-recovery-a'])
    expect(result.accepted.deliveryOutcome).toBe('accepted')
    expect(result.accepted.messageId).toBeTypeOf('string')
    expect(result.duplicate.messageId).toBe(result.accepted.messageId)
    expect(result.requests).toBe(0)
    if (stage === 'first-turn') {
      expect(result.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
      expect(result.events.filter(event => event.type === 'assistant/message')).toHaveLength(0)
      expect(result.effects.trim().split('\n').map(line => JSON.parse(line) as { effect: string; outcome: string })).toEqual([{ effect: 'started', outcome: 'unknown' }])
    }
  } finally { for (const child of children) await stop(child); await rm(home, { recursive: true, force: true }) }
}, 40000)

it('rejects one simultaneous exact create across processes without minting a second Session', async () => {
  const home = await mkdtemp(join(process.env.PANEDESK_HOME ?? process.cwd(), 'seat-contention-'))
  const first = start(home, 'compete'), second = start(home, 'compete')
  try {
    await Promise.all([first.wait(['ready']), second.wait(['ready'])])
    first.child.send('create'); second.child.send('create')
    const outcomes = await Promise.all([first.wait(['created', 'rejected']), second.wait(['created', 'rejected'])])
    expect(outcomes.map(item => item.stage).sort()).toEqual(['created', 'rejected'])
    expect(outcomes.find(item => item.stage === 'created')?.sessionId).toBe('seat-recovery-a')
    expect(outcomes.find(item => item.stage === 'rejected')?.error).toMatch(/owned|held|exist|identity|conflict/i)
    const logs = (await readdir(join(home, 'sessions'), { recursive: true })).filter(path => path.endsWith('.jsonl'))
    expect(logs).toHaveLength(1)
    const header = JSON.parse((await readFile(join(home, 'sessions', logs[0]!), 'utf8')).split('\n')[0]!) as { id: string }
    expect(header.id).toBe('seat-recovery-a')
  } finally { await stop(first.child); await stop(second.child); await rm(home, { recursive: true, force: true }) }
}, 40000)
