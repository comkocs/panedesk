/** Message-only journal provider sharing the full ledger's persisted node identity. */
import { join } from 'node:path'
import { Context, Service } from '@panedesk/cordis'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import type { MessageCursor, MessageQuery } from '@panedesk/dsh-message-delivery'
import { appendMessageUnique, ensureDirectory, resolveNodeId, type JournalOptions } from './journal.ts'
import { readMessagePage } from './message-reader.ts'
import type { LedgerNodeId, LedgerOptions, MessageLedgerEvent, MessageLedgerPage, MessageLedgerStore } from './types.ts'

/** Storage and lock limits for the message-only provider. */
export type Config = Pick<LedgerOptions, 'dshHome' | 'lockTimeoutMs' | 'lockRetryMs' | 'maxRecordBytes'>

declare module '@panedesk/cordis' {
  interface Context { messageLedger: MessageLedgerStore }
}

/** Registers message storage only, without run, call, or tool accounting hooks. */
export default class JournalMessageLedger extends Service implements MessageLedgerStore {
  private readonly home: string
  private readonly options: JournalOptions
  private node: Promise<{ root: string; id: LedgerNodeId }> | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'messageLedger')
    this.home = resolveDshHome(config.dshHome)
    this.options = {
      lockTimeoutMs: config.lockTimeoutMs ?? 30000,
      lockRetryMs: config.lockRetryMs ?? 10,
      maxRecordBytes: config.maxRecordBytes ?? 16 * 1024 * 1024,
    }
    for (const value of Object.values(this.options)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Ledger limits must be positive safe integers')
    }
  }

  private location(): Promise<{ root: string; id: LedgerNodeId }> {
    this.node ??= (async () => {
      const id = await resolveNodeId(join(this.home, 'ledger', 'v1'), this.options)
      const root = join(this.home, 'ledger', 'messages', 'v1', id)
      await ensureDirectory(root)
      return { root, id }
    })()
    return this.node
  }

  async nodeId(): Promise<LedgerNodeId> {
    return (await this.location()).id
  }

  async append(event: MessageLedgerEvent): Promise<MessageCursor> {
    return appendMessageUnique((await this.location()).root, event, this.options)
  }

  async read(query: MessageQuery): Promise<MessageLedgerPage> {
    const { root } = await this.location()
    return readMessagePage(root, this.options, query)
  }
}
