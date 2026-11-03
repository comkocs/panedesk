/** Interrupted filesystem operations must leave a recoverable credential document. */
import { Context } from '@panedesk/cordis'
import { credentialRef } from '@panedesk/dsh-credentials'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LocalCredentialProvider } from '../src/index.ts'

const faults = vi.hoisted(() => ({ enabled: false, after: -1, operations: [] as string[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  function checkpoint(name: string): void {
    if (!faults.enabled) return
    faults.operations.push(name)
    if (faults.operations.length === faults.after) {
      faults.enabled = false
      throw new Error('simulated relocation interruption')
    }
  }
  function traced<T extends (...args: never[]) => Promise<unknown>>(name: string, operation: T): T {
    return new Proxy(operation, {
      async apply(target, _receiver, args: Parameters<T>) {
        const result = await target(...args)
        checkpoint(name)
        return result
      },
    })
  }
  return {
    ...actual,
    stat: traced('stat', actual.stat),
    mkdir: traced('mkdir', actual.mkdir),
    chmod: traced('chmod', actual.chmod),
    readFile: traced('readFile', actual.readFile),
    writeFile: traced('writeFile', actual.writeFile),
    rename: traced('rename', actual.rename),
    unlink: traced('unlink', actual.unlink),
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      handle.sync = traced(`sync:${String(args[0])}`, handle.sync.bind(handle))
      handle.close = traced('close', handle.close.bind(handle))
      try { checkpoint('open') } catch (error) {
        await handle.close()
        throw error
      }
      return handle
    },
  }
})

async function prepare(): Promise<{ home: string; text: string }> {
  const home = await mkdtemp(join(tmpdir(), 'credential-io-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const text = 'version: 1\nrefs:\n  SYNTHETIC_LOGIN: saved\n'
  await writeFile(join(home, '.credentials.yaml'), text, { mode: 0o600 })
  return { home, text }
}

async function boot(home: string): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
  onTestFinished(() => fiber.dispose())
  await fiber
  return ctx
}

it('syncs the new directory entry in the home before deleting the legacy document', async () => {
  const { home } = await prepare()
  faults.operations = []
  faults.after = -1
  faults.enabled = true
  try { await boot(home) } finally { faults.enabled = false }
  const homeSync = faults.operations.indexOf(`sync:${home}`)
  expect(homeSync).toBeGreaterThan(-1)
  expect(homeSync).toBeLessThan(faults.operations.indexOf('unlink'))
})

it('restarts after every completed relocation I/O without losing or duplicating credentials', async () => {
  const baseline = await prepare()
  faults.operations = []
  faults.after = -1
  faults.enabled = true
  try { await boot(baseline.home) } finally { faults.enabled = false }
  const operations = [...faults.operations]
  expect(operations).toContain('rename')
  expect(operations).toContain('unlink')
  for (let index = 0; index < operations.length; index += 1) {
    const { home, text } = await prepare()
    faults.operations = []
    faults.after = index + 1
    faults.enabled = true
    await expect(boot(home), `interrupt after ${index + 1}: ${operations[index]}`)
      .rejects.toThrow('simulated relocation interruption')
    faults.enabled = false
    // A failed lock acquisition still owns a real completed write in this process.
    // Remove only this fixture's locks to model the exited holder being reclaimed.
    await rm(join(home, '.credentials.yaml.lock'), { force: true })
    await rm(join(home, 'private', '.credentials.yaml.lock'), { force: true })
    const ctx = await boot(home)
    expect(await readFile(join(home, 'private', '.credentials.yaml'), 'utf8')).toBe(text)
    expect(await readdir(home)).not.toContain('.credentials.yaml')
    expect(await ctx.credentials.resolve(credentialRef('SYNTHETIC_LOGIN')))
      .toEqual({ value: 'saved', source: 'file' })
    expect((await readdir(join(home, 'private'))).filter(name => name === '.credentials.yaml')).toHaveLength(1)
    const restarted = await boot(home)
    expect(await restarted.credentials.resolve(credentialRef('SYNTHETIC_LOGIN')))
      .toEqual({ value: 'saved', source: 'file' })
  }
})
