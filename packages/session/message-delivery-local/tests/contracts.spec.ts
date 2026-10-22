import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import AgentRegistry from '@panedesk/dsh-agent'
import { expect, it } from 'vitest'
import LocalMessageDelivery from '../src/index.ts'
import SessionStore from '@panedesk/dsh-session'
import { MemoryPersistence } from './fixtures/persistence.ts'
import { FileMailbox } from '../src/mailbox.ts'
import { publishedFiles } from '../src/files.ts'

it('initializes the real local mailbox entry and removes its process registration on disposal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'delivery-entry-'))
  const ctx = new Context()
  try {
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(MemoryPersistence)
    const config = { dshHome: home, nodeId: 'node-a', maxRecordBytes: 65536,
      maxContentBytes: 4096, maxBatchSize: 100, watch: false,
      lockTimeoutMs: 5000, lockRetryMs: 1, scanIntervalMs: 1000 }
    const fiber = await ctx.plugin(LocalMessageDelivery, config)
    const mailbox = new FileMailbox({ ...config, home })
    expect(await ctx.messageDelivery.resolve([])).toEqual([])
    expect(await mailbox.snapshot('seat-a')).toEqual({ records: [], high: 0, skipped: [] })
    await fiber.dispose()
    expect(await publishedFiles(join(mailbox.root, 'registry'))).toEqual([])
  } finally {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
