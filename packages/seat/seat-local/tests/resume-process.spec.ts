/** Separate Loader processes reconstruct the same persisted Session and run labels. */
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('keeps first-residency resume labels after two real process restarts', async () => {
  const root = await mkdtemp(join(process.cwd(), '.seat-resume-process-'))
  const children: ChildProcess[] = []
  const pids: number[] = []
  try {
    for (const phase of ['create', 'resume', 'verify']) {
      const child = fork(fileURLToPath(new URL('./resume-process-worker.ts', import.meta.url)), [root, phase], {
        execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/.test(key))),
          TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.json') },
      })
      children.push(child)
      if (child.pid === undefined) throw new Error('Child did not acquire a PID')
      pids.push(child.pid)
      let output = ''
      child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
      const exited = once(child, 'exit')
      const timer = setTimeout(() => { child.kill('SIGKILL') }, 15000)
      try { expect(await exited, output).toEqual([0, null]) }
      finally { clearTimeout(timer) }
    }
    expect(new Set(pids).size).toBe(3)
    expect(JSON.parse(await readFile(join(root, 'resume.json'), 'utf8'))).toMatchObject({ firstObserved: true, runs: 2 })
    expect(JSON.parse(await readFile(join(root, 'verify.json'), 'utf8'))).toMatchObject({ firstObserved: true, runs: 3 })
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await rm(root, { recursive: true, force: true })
  }
}, 60000)
