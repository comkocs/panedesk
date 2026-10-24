import { expect, it } from 'vitest'
import { fork, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Message = {
  kind: string
  readyAt?: string
  resources?: number
  pending?: number
  release?: { reason: string; fenced: boolean; engineReadyAt: string | null }
}
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/.test(key)))
function host(home: string, pid: number, mode: string, phase = 'seed') {
  const child = fork(fileURLToPath(new URL('./owner-process-worker.ts', import.meta.url)), [home, String(pid), mode, phase], {
    execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: environment,
  })
  const messages: { message: Message; at: number }[] = [], listeners = new Set<() => void>()
  let errors = ''
  child.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString() })
  child.on('message', (value: unknown) => {
    if (value && typeof value === 'object' && 'kind' in value && typeof value.kind === 'string') {
      messages.push({ message: value as Message, at: performance.now() })
      for (const notify of listeners) notify()
    }
  })
  child.on('exit', () => { for (const notify of listeners) notify() })
  const wait = (kind: string, timeout = 10000) => new Promise<{ message: Message; at: number }>((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Missing ${kind}: ${errors}`)) }, timeout)
    function check() {
      const found = messages.find(item => item.message.kind === kind)
      if (found) { clearTimeout(timer); listeners.delete(check); resolve(found) }
      else if (child.exitCode !== null || child.signalCode !== null) {
        clearTimeout(timer); listeners.delete(check); reject(new Error(`Host exited: ${errors}`))
      }
    }
    listeners.add(check); check()
  })
  return { child, wait, messages }
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
}
async function scenario(mode: string, restart = false) {
  const home = await mkdtemp(join(tmpdir(), 'seat-owner-')), children: ChildProcess[] = []
  try {
    const holder = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'pipe', 'ignore'], env: environment,
    }); children.push(holder)
    await once(holder.stdout, 'data')
    expect(holder.pid).toBeTypeOf('number')
    let running = host(home, holder.pid!, mode); children.push(running.child)
    expect((await running.wait('seeded')).message).toMatchObject({ resources: 1, pending: 1 })
    if (mode === 'slow') await running.wait('callback-started')
    if (restart) await kill(running.child)
    // Child exit is the externally observable death boundary, not an injected owner result.
    const exited = once(holder, 'exit')
    let observedAt = 0
    holder.once('exit', () => { observedAt = performance.now() })
    holder.kill('SIGKILL'); expect(await exited).toEqual([null, 'SIGKILL'])
    if (restart) {
      running = host(home, holder.pid!, mode, 'recover'); children.push(running.child)
      const ready = await running.wait('ready')
      if (!ready.message.readyAt) throw new Error('Missing engine ready timestamp')
      observedAt = performance.now() - (Date.now() - Date.parse(ready.message.readyAt))
    }
    if (mode === 'unknown') {
      const observed = running.wait('unknown-observed')
      running.child.send('observe-unknown')
      const retained = await observed
      expect(retained.at - observedAt).toBeGreaterThanOrEqual(5200)
      expect(retained.message).toMatchObject({ resources: 1, pending: 1 })
      expect(running.messages.some(item => item.message.kind === 'released')).toBe(false)
      return { releaseMs: 0, admissionMs: 0 }
    }
    const released = await running.wait('released', 5000), admitted = await running.wait('admitted', 5000)
    const elapsed = admitted.at - observedAt
    expect(released.message.release).toMatchObject({ reason: restart ? 'host-restart-recovery' : 'holder-death', fenced: true })
    expect(released.at - observedAt).toBeLessThanOrEqual(5000)
    expect(elapsed).toBeLessThanOrEqual(5000)
    if (restart) expect(released.message.release?.engineReadyAt).toBeTypeOf('string')
    if (mode === 'slow') {
      const stopped = once(running.child, 'exit'); running.child.send('stop')
      expect(await stopped).toEqual([0, null])
    }
    return { releaseMs: released.at - observedAt, admissionMs: elapsed }
  } finally {
    for (const child of children.reverse()) await kill(child)
    await rm(home, { recursive: true, force: true })
  }
}
it.each([false, true])('releases tags and capacity after real owner SIGKILL, host restart=%s, five trials', async (restart) => {
  const measurements: { releaseMs: number; admissionMs: number }[] = []
  for (let trial = 0; trial < 5; trial++) measurements.push(await scenario('normal', restart))
  process.stdout.write(`${JSON.stringify({ scenario: restart ? 'ready-to-release' : 'observed-death-to-release', measurements,
    maximumRelease: Math.max(...measurements.map(item => item.releaseMs)),
    maximumAdmission: Math.max(...measurements.map(item => item.admissionMs)) })}\n`)
}, 90000)
it('retains an unknown owner after real SIGKILL without verified process evidence', async () => {
  await scenario('unknown')
}, 20000)
it('a suspended callback does not block parallel release and admission after real SIGKILL', async () => {
  const milliseconds = await scenario('slow')
  process.stdout.write(`${JSON.stringify({ scenario: 'suspended-callback-release', milliseconds })}\n`)
}, 20000)
