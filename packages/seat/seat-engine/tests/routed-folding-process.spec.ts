/** Interrupted retry series recover by exact owner lookup without another business effect. */
import { expect, test } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function start(home: string, stage: string) {
  const child = fork(fileURLToPath(new URL('./routed-folding-worker.ts', import.meta.url)), [home, stage], {
    execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/.test(key))),
  })
  let output = ''
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const exited = once(child, 'exit')
  const message = new Promise<unknown>((resolve, reject) => {
    child.once('message', resolve); child.once('error', reject)
    child.once('exit', () => { reject(new Error(`Worker exited before observation: ${output}`)) })
  })
  return { child, exited, message }
}

test('SIGKILL after the seventh dispatch preserves one barrier and exactly one owner effect', async () => {
  const home = await mkdtemp(join(tmpdir(), 'callback-folding-process-')), children: ChildProcess[] = []
  try {
    const first = start(home, 'interrupt'); children.push(first.child)
    expect(first.child.pid).toBeTypeOf('number')
    expect(await first.message).toMatchObject({ stage: 'interrupt', pid: first.child.pid, dispatches: 7, frames: 1 })
    first.child.kill('SIGKILL')
    expect(await first.exited).toEqual([null, 'SIGKILL'])
    const recovery = start(home, 'recover'); children.push(recovery.child)
    expect(await recovery.message).toEqual({ stage: 'recovered', dispatches: 0, seen: ['chain.operation'],
      original: true, lowerBound: true, count: 0, phase: 'delivered', frames: 1 })
    expect(await recovery.exited).toEqual([0, null])
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    }
    await rm(home, { recursive: true, force: true })
  }
}, 20000)
