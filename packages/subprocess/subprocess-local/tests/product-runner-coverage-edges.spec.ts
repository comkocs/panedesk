import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { consumeLinuxLaunchRequest, createLinuxLaunchFiles, readLinuxStartupError } from '../src/runner-protocol.ts'
import { runSpawnRunner, type SpawnRunnerInternals } from '../src/spawn-runner.ts'

const bootstrap = vi.hoisted(() => vi.fn())
vi.mock('../src/linux-product-bootstrap.ts', () => ({ enterLinuxProductGroup: bootstrap }))
afterEach(() => { vi.resetAllMocks() })

function exchange() {
  const root = mkdtempSync(join(tmpdir(), 'product-runner-edges-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return createLinuxLaunchFiles({ cwd: root, env: {}, productSandbox: true }, root)
}

it('consumes the product confinement flag and removes its one-shot request', () => {
  const files = exchange()
  const request = consumeLinuxLaunchRequest(files.requestPath)
  expect(request.productSandbox).toBe(true)
  expect(existsSync(files.requestPath)).toBe(false)
  writeFileSync(files.requestPath, JSON.stringify({ cwd: files.directory, env: {}, productSandbox: false }))
  expect(() => consumeLinuxLaunchRequest(files.requestPath)).toThrow('invalid Linux launch request')
  expect(existsSync(files.requestPath)).toBe(false)
})

it.each([false, true])('registers product ownership before target exec and reports bootstrap refusal: %s', async (refuse) => {
  const files = exchange()
  const order: string[] = []
  const host: NonNullable<Parameters<typeof runSpawnRunner>[2]> = {
    env: {}, exitCode: undefined, connected: false, cwd: () => files.directory,
    chdir: () => { order.push('cwd') }, disconnect: () => {},
    on: () => process, off: () => process, once: () => process,
  }
  bootstrap.mockImplementation(() => {
    order.push('register')
    if (refuse) throw new Error('Registration refused')
  })
  const execve = vi.fn<SpawnRunnerInternals['execve']>(() => {
    order.push('exec')
    throw new Error('Synthetic target replacement')
  })
  const native: SpawnRunnerInternals = {
    execve,
    loadWin32ProcessBindings: () => { throw new Error('Windows is not used') },
    spawnCurrentTokenJobProcess: () => { throw new Error('Windows is not used') },
    closeFileDescriptor: () => {}, resolveWindowsExecutable: () => { throw new Error('Windows is not used') },
    pollProcessExit: () => undefined, isJobEmpty: () => true, terminateJob: () => {}, closeHandleChecked: () => {},
  }
  await runSpawnRunner(files.requestPath, ['--', '/synthetic-target'], host, native)
  expect(order).toEqual(refuse ? ['cwd', 'register'] : ['cwd', 'register', 'exec'])
  expect(bootstrap).toHaveBeenCalledExactlyOnceWith(files)
  expect(execve).toHaveBeenCalledTimes(refuse ? 0 : 1)
  expect(host.exitCode).toBe(127)
  expect(readLinuxStartupError(files.startupErrorPath)?.error.message)
    .toBe(refuse ? 'Registration refused' : 'Synthetic target replacement')
})
