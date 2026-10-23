/** Real process restarts retain inherited child metadata and ledger labels. */
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('restores inherited bindings and parent links after two real host process restarts', async () => {
  const root = await mkdtemp(join(process.cwd(), '.seat-child-binding-process-'))
  const children: ChildProcess[] = []
  const pids: number[] = []
  try {
    for (const phase of ['create', 'resume', 'verify']) {
      const child = fork(fileURLToPath(new URL('./child-binding-process-worker.ts', import.meta.url)), [root, phase], {
        execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/.test(key))),
          TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.json') },
      })
      children.push(child)
      if (child.pid === undefined) throw new Error('Child did not acquire a PID')
      pids.push(child.pid)
      let output = ''
      let observed: unknown
      child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.on('message', (message) => { observed = message })
      const exited = once(child, 'exit')
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 20000)
      try {
        expect(await exited, output).toEqual([0, null])
        expect(timedOut).toBe(false)
        expect(observed).toMatchObject({ kind: phase === 'create' ? 'created' : phase, pid: child.pid,
          ...(phase === 'create' ? { sessions: 5 } : { inherited: 4 }) })
      } finally { clearTimeout(timer) }
    }
    expect(new Set(pids).size).toBe(3)
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await rm(root, { recursive: true, force: true })
  }
}, 90000)
