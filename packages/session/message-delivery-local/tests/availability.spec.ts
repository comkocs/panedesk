/** Local mailbox capabilities are checked before identity lookup or activation. */
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@panedesk/cordis'
import AgentRegistry from '@panedesk/dsh-agent'
import SessionStore from '@panedesk/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LocalMessageDelivery, { type Config } from '../src/index.ts'
import { MemoryPersistence, RecordingLedger } from './fixtures/persistence.ts'

const capability = vi.hoisted(() => ({ filesystem: true }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, get lstat() { return capability.filesystem ? actual.lstat : undefined } }
})

const config: Config = {
  maxRecordBytes: 1048576, maxContentBytes: 65536, maxBatchSize: 100,
  scanIntervalMs: 100, lockTimeoutMs: 5000, lockRetryMs: 10, watch: false,
}

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  capability.filesystem = true
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function host() {
  const ctx = new Context()
  contexts.push(ctx)
  const errors: unknown[][] = []
  ctx.logger.exporter({ export(message) { if (message.type === 'error') errors.push(message.args) } })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(MemoryPersistence)
  await ctx.plugin(RecordingLedger)
  const nodeId = vi.fn<() => Promise<never>>().mockRejectedValue(new Error('Local identity storage failed'))
  ctx.messageLedger.nodeId = nodeId
  return { ctx, errors, nodeId }
}

describe('local message delivery availability', () => {
  it('stays disabled without a local filesystem and emits no error logs', async () => {
    const { ctx, errors, nodeId } = await host()
    capability.filesystem = false
    await ctx.plugin(LocalMessageDelivery, config)
    expect(ctx.get('messageDelivery')).toBeUndefined()
    expect(nodeId).not.toHaveBeenCalled()
    expect(errors).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('stays disabled when a worker filesystem has no local ownership', async () => {
    const { ctx, errors, nodeId } = await host()
    vi.stubGlobal('process', { ...process, getuid: undefined, getgid: undefined })
    await ctx.plugin(LocalMessageDelivery, config)
    expect(ctx.get('messageDelivery')).toBeUndefined()
    expect(nodeId).not.toHaveBeenCalled()
    expect(errors).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('retains and logs the home permissions refusal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'inbox-home-'))
    try {
      await chmod(home, 0o777)
      const { ctx, errors, nodeId } = await host()
      nodeId.mockResolvedValue('node' as never)
      await ctx.plugin(LocalMessageDelivery, { ...config, dshHome: home })
      expect(ctx.get('messageDelivery')).toBeUndefined()
      expect(ctx.get('messageDeliveryUnavailable')).toEqual({ code: 'home-permissions', path: home })
      expect(errors.some(args => args.includes('home-permissions') && args.includes(home))).toBe(true)
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  it('reports initialization failures on a Node host and leaves delivery disabled', async () => {
    const { ctx, errors, nodeId } = await host()
    await ctx.plugin(LocalMessageDelivery, config)
    expect(nodeId).toHaveBeenCalledOnce()
    expect(ctx.get('messageDelivery')).toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.[0]).toBe('Message delivery unavailable: initialization failed')
    expect(errors[0]?.[1]).toMatchObject({
      name: 'MailboxUnavailableError', cause: { message: 'Local identity storage failed' },
    })
  })
})
