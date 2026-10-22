/** Real child-process crash/reopen fixtures with private test homes and captured PIDs. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Exit evidence from one owned process generation. */
export interface TestProcessExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/** One real child; only this captured process can be terminated by the fixture. */
export interface TestProcess {
  /** OS-assigned identity; never selected by process name. */
  readonly pid: number
  /** Resolves after exit and stdio closure. */
  readonly exited: Promise<TestProcessExit>
  /** Kill this generation and wait for its descriptors to close. */
  crash(): Promise<TestProcessExit>
}

/** A unique private home retained across real process generations. */
export interface ProcessFixture {
  /** Scenario directory; tests can inspect durable output here. */
  readonly root: string
  /** Private product home shared only by this fixture's generations. */
  readonly home: string
  /** Start a real command; wait for explicit stdout readiness or reject on timeout/early exit. */
  start(command: string, args: readonly string[], readyText: string, timeoutMs: number): Promise<TestProcess>
  /** Kill only owned live children, drain them, then remove this fixture's directory. */
  dispose(): Promise<void>
}

/**
 * Create a unique scenario directory under a caller-selected scratch parent.
 * Session persistence, leases, and mailbox code remain entirely real.
 * @param parent - existing scratch parent owned by the test run.
 * @returns a fixture whose dispose method must be awaited in teardown.
 */
export async function createProcessFixture(parent: string): Promise<ProcessFixture> {
  const root = await mkdtemp(join(parent, 'process-fixture-'))
  const home = join(root, 'home')
  await mkdir(home, { mode: 0o700 })
  const children = new Map<ChildProcess, TestProcess>()
  let disposed = false
  return {
    root,
    home,
    async start(command, args, readyText, timeoutMs) {
      if (disposed) throw new Error('process fixture is disposed')
      if (readyText.length === 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error('process readiness requires text and a positive timeout')
      }
      const child = spawn(command, [...args], {
        cwd: root,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const ready = Promise.withResolvers<void>()
      const exit = Promise.withResolvers<TestProcessExit>()
      let output = ''
      const observe = (chunk: Buffer): void => {
        output = (output + chunk.toString('utf8')).slice(-65_536)
        if (output.includes(readyText)) ready.resolve()
      }
      child.stdout.on('data', observe)
      child.stderr.resume()
      child.once('error', (error) => { ready.reject(error) })
      child.once('close', (code, signal) => {
        children.delete(child)
        exit.resolve({ code, signal })
        ready.reject(new Error(`process exited before readiness: ${code ?? signal}`))
      })
      const timer = setTimeout(() => { ready.reject(new Error('process readiness timed out')) }, timeoutMs)
      const handle: TestProcess = {
        pid: child.pid ?? 0,
        exited: exit.promise,
        async crash() {
          if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) child.kill('SIGKILL')
          return exit.promise
        },
      }
      children.set(child, handle)
      try {
        await ready.promise
        return handle
      } catch (error) {
        await handle.crash()
        throw error
      } finally {
        clearTimeout(timer)
        child.stdout.off('data', observe)
        child.stdout.resume()
      }
    },
    async dispose() {
      disposed = true
      await Promise.all([...children.values()].map(child => child.crash()))
      await rm(root, { recursive: true, force: true })
    },
  }
}
