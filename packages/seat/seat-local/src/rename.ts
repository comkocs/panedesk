/** Durable rename receipts preserve the original pinned title across later renames. */
import type { Context } from '@panedesk/cordis'
import { defineDomain, domainTable, type Domain } from '@panedesk/dsh-storage-domain'
import { SessionId, SessionSeq } from '@panedesk/dsh-session'
import { SessionTitleInvalidError } from '@panedesk/dsh-session-title'
import type { RenameSeatRequest, RenameSeatResult } from '@panedesk/dsh-seat'
import { z } from 'zod'
import { digest } from './store.ts'
import { rejected } from './errors.ts'

const titleSchema = z.object({ title: z.string(), messageSeqs: z.array(z.number().int().nonnegative().transform(SessionSeq)),
  source: z.object({ kind: z.literal('user') }), eventSeq: z.number().int().nonnegative().transform(SessionSeq), updatedAt: z.number() })
const receiptSchema = z.object({ digest: z.string(), sessionId: z.string().transform(SessionId), requested: z.string(),
  beforeSeq: z.number().int(), phase: z.enum(['intent', 'staged', 'settled']), title: titleSchema.optional() })
const spec = defineDomain({ name: 'seat_renames', version: 1, tables: { operations: domainTable<string, z.infer<typeof receiptSchema>>(receiptSchema) } })

/** A provider owns serialized title changes and the private operation-receipt domain. */
export class LocalRenamer {
  private domain?: Promise<Domain<typeof spec>>
  private tail: Promise<void> = Promise.resolve()
  private stopped = false
  constructor(private readonly ctx: Context) {}

  /** Persist intent, pin the upstream title, flush it, then commit the replay receipt.
   * @param request - authenticated exact Session and stable operation identity.
   * @returns original committed title on replay, or a structured refusal.
   */
  rename(request: RenameSeatRequest): Promise<RenameSeatResult> {
    if (this.stopped) return Promise.resolve(rejected('unavailable', 'Title writes are stopping.', 'Retry after provider recovery.'))
    const work = this.tail.then(() => this.run(request))
    this.tail = work.then(() => {}, () => {})
    return work
  }
  private async run(request: RenameSeatRequest): Promise<RenameSeatResult> {
    const facility = this.ctx.get('storageDomain')
    if (!facility) return rejected('unavailable', 'Title receipts are unavailable.', 'Restore local storage before renaming.')
    this.domain ??= facility.open(spec)
    const table = (await this.domain).table('operations')
    const key = String(request.operationId)
    const fingerprint = digest({ sessionId: request.sessionId, title: request.title })
    let receipt = table.get(key)
    if (receipt && receipt.digest !== fingerprint) {
      return rejected('operation-id-conflict', 'The rename identity has different contents.', 'Use the original title request.')
    }
    if (receipt?.phase === 'settled' && receipt.title) return { status: 'renamed', sessionId: request.sessionId, title: receipt.title }
    if ([...table.entries()].some(([id, value]) => id !== key && value.sessionId === request.sessionId && value.phase !== 'settled')) {
      return rejected('state-conflict', 'An earlier title operation is unfinished.', 'Replay the original rename before another change.')
    }
    const session = this.ctx.get('sessions')?.get(request.sessionId)
    const titles = this.ctx.get('sessionTitle')
    const sessions = this.ctx.get('sessions')
    const query = this.ctx.get('sessionQuery')
    if (!session || !titles || !sessions || !query) return rejected('unavailable', 'Title ownership is unavailable.', 'Resume this local window first.')
    if (!receipt) {
      receipt = { digest: fingerprint, sessionId: request.sessionId, requested: request.title,
        beforeSeq: session.seq - 1, phase: 'intent' }
      await table.put(key, receipt)
    }
    if (!receipt.title) {
      const beforeSeq = receipt.beforeSeq
      const ambiguous = (await query.readSession(session.id)).events.some(event => event.seq > beforeSeq && event.type === 'session/title')
      if (ambiguous) return rejected('state-conflict', 'An unfinished rename overlaps a title change.', 'Inspect the saved title before retrying.')
      let title
      try { title = titles.rename(session, request.title) }
      catch (error) {
        if (!(error instanceof SessionTitleInvalidError)) throw error
        // Invalid input is rejected before any title event; it cannot leave an unfinished write.
        await table.delete(key)
        return rejected('invalid-request', 'The title contains no visible characters.', 'Provide a non-empty visible title.')
      }
      if (title.source.kind !== 'user') throw new Error('Explicit rename did not pin a user title')
      receipt = { ...receipt, phase: 'staged', title: { ...title, source: { kind: 'user' } } }
      await table.put(key, receipt)
    }
    const title = receipt.title
    if (!title) throw new Error('Rename receipt has no staged title')
    const saved = (await query.readSession(session.id)).events.find(event => event.seq === title.eventSeq && event.type === 'session/title')
    if (!saved || saved.type !== 'session/title' || saved.data.title !== title.title || saved.data.source.kind !== 'user') {
      return rejected('state-conflict', 'The staged title is not present in Session history.', 'Restore the original Session before retrying.')
    }
    if (!await sessions.flush(session)) throw new Error('Title persistence did not acknowledge the rename')
    await table.put(key, { ...receipt, phase: 'settled' })
    return { status: 'renamed', sessionId: request.sessionId, title }
  }
  /** Drain accepted title work before closing owned receipt storage.
   * @returns after receipt storage releases its owner.
   */
  async close(): Promise<void> {
    this.stopped = true
    await this.tail
    await (await this.domain)?.close()
  }
}
