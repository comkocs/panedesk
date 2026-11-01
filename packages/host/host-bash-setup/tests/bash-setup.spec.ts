/** The discovery Remote commits only what the caller confirmed and reports the committed state. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@panedesk/cordis'
import { readWindowsBashConfig } from '@panedesk/dsh-bash-local'
import BashSetupGateway from '../src/index.ts'

const contexts: Context[] = []
const homes: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
  delete process.env.PANEDESK_HOME
  delete process.env.PANEDESK_BASH_PATH
})

async function harness(env: Record<string, string | undefined> = {}): Promise<BashSetupGateway> {
  const home = await mkdtemp(join(tmpdir(), 'bash-setup-'))
  homes.push(home)
  process.env.PANEDESK_HOME = home
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  const ctx = new Context()
  contexts.push(ctx)
  Object.defineProperty(ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } }, signal: new AbortController().signal } })
  await ctx.plugin(BashSetupGateway)
  return ctx.get('bashSetup') as BashSetupGateway
}

describe('BashSetupGateway', () => {
  it('reports the host platform with no committed selection by default', async () => {
    const gateway = await harness()
    const status = await gateway.status()
    expect(status.platform).toBe(process.platform)
    expect(status.config).toBeUndefined()
    expect(status.envOverride).toBeUndefined()
    expect(readWindowsBashConfig()).toBeUndefined()
  })

  it('reports the environment override alongside an uncommitted probe', async () => {
    const override = 'D:\\Tools\\git\\bin\\bash.exe'
    const gateway = await harness({ PANEDESK_BASH_PATH: override })
    expect((await gateway.status()).envOverride).toBe(override)
    expect(readWindowsBashConfig()).toBeUndefined()
  })

  it('commits the confirmed selection, reports it, and clears back to the default', async () => {
    const gateway = await harness()
    const bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe'
    const before = await gateway.status()
    expect(before.config).toBeUndefined()
    const after = await gateway.enable({ bashPath })
    expect(after.config).toEqual({ enabled: true, bashPath })
    expect((await gateway.status()).config).toEqual({ enabled: true, bashPath })
    const cleared = await gateway.disable()
    expect(cleared.config).toBeUndefined()
    expect(readWindowsBashConfig()).toBeUndefined()
  })

  it.each(['anonymous', 'missing', 'aborted'] as const)('rejects %s writes without changing the selection', async (caller) => {
    const gateway = await harness()
    const ctx = contexts[contexts.length - 1]!
    const invocation = caller === 'missing' ? undefined : { peer: { principal: { kind: caller === 'anonymous' ? 'anonymous' : 'owner' } }, signal: caller === 'aborted' ? AbortSignal.abort() : new AbortController().signal }
    Object.defineProperty(ctx, 'invocation', { configurable: true, value: invocation })
    const refusal = caller === 'aborted' ? { code: 'gateway/cancelled', message: 'Bash setup unavailable' } : { code: 'gateway/bad-request', message: 'Authenticated owner required' }
    await expect(gateway.enable({ bashPath: 'C:\\Git\\bash.exe' })).rejects.toMatchObject(refusal)
    await expect(gateway.disable()).rejects.toMatchObject(refusal)
    expect(readWindowsBashConfig()).toBeUndefined()
  })

  it('refuses a selection without a usable path instead of committing a broken gate', async () => {
    const gateway = await harness()
    await expect(gateway.enable({ bashPath: '' })).rejects.toThrow('nonempty bashPath')
    expect(readWindowsBashConfig()).toBeUndefined()
  })
})
