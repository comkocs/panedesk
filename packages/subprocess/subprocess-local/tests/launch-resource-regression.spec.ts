/** Product launches release empty temporary directories and preserve native failures. */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import LocalSubprocessRuntime from '../src/index.ts'
import { deserializeRunnerError, serializeRunnerError } from '../src/runner-protocol.ts'

const launchDirectories = (): string[] => readdirSync(tmpdir()).filter(name => name.startsWith('dsh-subprocess-')).sort()

describe('launch resource regression', () => {
  it('returns temporary directory counts to baseline after success, failure and cancellation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'launch-resources-'))
    onTestFinished(() => {
      vi.unstubAllEnvs()
      rmSync(root, { recursive: true, force: true })
    })
    vi.stubEnv('TMPDIR', root)
    vi.stubEnv('TMP', root)
    vi.stubEnv('TEMP', root)
    vi.stubEnv('PANEDESK_HOME', join(root, 'home'))
    const before = launchDirectories()
    const ctx = new Context()
    const fiber = ctx.plugin(LocalSubprocessRuntime)
    await fiber.await()
    try {
      for (const kind of ['success', 'product', 'failure', 'cancel', 'timeout', 'missing'] as const) {
        const controller = new AbortController()
        const handle = ctx.subprocess.spawn({
          argv: kind === 'missing' ? ['/missing-subprocess-resource-command']
            : [process.execPath, '-e', kind === 'failure' ? 'process.exitCode = 7'
              : kind === 'cancel' || kind === 'timeout' ? 'setInterval(() => {}, 1000)' : 'process.stdout.write("finished")'],
          cwd: process.cwd(),
          stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
          graceMs: 200,
          signal: kind === 'timeout' ? AbortSignal.timeout(50) : controller.signal,
          ...kind === 'product' ? { productSandbox: true as const } : {},
        })
        if (kind === 'cancel') controller.abort(new Error('cancelled resource check'))
        if (kind === 'missing') await expect(handle.done).rejects.toHaveProperty('code', 'ENOENT')
        else await handle.done
        await handle.waitForExit()
      }
      expect(launchDirectories()).toEqual(before)
    } finally {
      await fiber.dispose()
    }
  })

  it('preserves original execve errno through the private error transport', () => {
    const native = Object.assign(new Error('EFAULT: bad address, execve target'), {
      code: 'EFAULT', errno: -14, syscall: 'execve', path: '/target',
    })
    const serialized = serializeRunnerError(native)
    expect(serialized).toEqual({
      name: 'Error', message: native.message, code: 'EFAULT', errno: -14, syscall: 'execve', path: '/target',
    })
    const restored = deserializeRunnerError(serialized)
    expect(restored.message).toBe(native.message)
    expect(Object.assign({}, restored)).toEqual({
      name: 'Error', code: 'EFAULT', errno: -14, syscall: 'execve', path: '/target',
    })
  })
})
