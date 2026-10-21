/** Read-only service definition for ledger selection, daily summaries, and safe exports. */
import { Context, Service } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-session-ledger'
import type { LedgerExportOptions, LedgerExportResult, LedgerQueryOptions, LedgerQueryResult, LedgerTodaySummary } from './types.ts'
import { cacheRemaining, liveSessions, selectLedger, summarizeToday } from './query.ts'
import { mergeLedger, readLedgerExport, verifyLedger, writeExport } from './export.ts'
import { parseLedgerArgs } from './cli.ts'
export type * from './types.ts'

declare module '@panedesk/cordis' {
  interface Context {
    ledgerQuery: LedgerQueryService
  }
}

/** Query providers read ledger snapshots without launching an Agent or model provider. */
export class LedgerQueryService extends Service {
  static inject: string[] = []

  private readonly freshnessMs: number

  constructor(ctx: Context, config: { observationFreshnessMs?: number } = {}) {
    super(ctx, 'ledgerQuery')
    this.freshnessMs = config.observationFreshnessMs ?? 10000
    if (!Number.isFinite(this.freshnessMs) || this.freshnessMs <= 0) throw new Error('Invalid observation freshness')
  }

  private async source() {
    const ledger = this.ctx.get('sessionLedger')
    if (!ledger) return { asOf: Date.now(), complete: false, watermarks: {}, rows: [] }
    const merged = mergeLedger([await ledger.snapshot()])
    if (merged.conflicts.length) throw new Error('Conflicting ledger projections require explicit merge review')
    return merged.snapshot
  }

  /** Select and group unique call projections.
   * @param options - half-open time, attribution, and grouping selection.
   * @returns source snapshot and coverage-aware grouped totals.
   */
  async query(options: LedgerQueryOptions): Promise<LedgerQueryResult> {
    return selectLedger(await this.source(), options)
  }
  /** Compute today's overview at the runtime clock or an explicit observation instant.
   * @param asOf - optional UTC millisecond observation time; omission reads the system clock.
   * @returns Beijing-day totals and node observation coverage.
   */
  async today(asOf?: number): Promise<LedgerTodaySummary> {
    const source = await this.source()
    return summarizeToday(source, asOf ?? Date.now(), this.freshnessMs)
  }
  /** Export selected rows in stable time, node, and call order.
   * @param options - selection, format, and caller-authorized destination.
   * @returns output acknowledgement and source snapshot watermarks.
   */
  async export(options: LedgerExportOptions): Promise<LedgerExportResult> {
    const { snapshot } = await this.query(options.query)
    await writeExport(snapshot, options.format, options.outputPath)
    return { outputPath: options.outputPath, rows: snapshot.rows.length, snapshot }
  }

  /** Execute validated offline command arguments without loading a model runtime.
   * @param args - boot/cmdline inner arguments.
   * @returns structured command output and a conflict-aware exit status.
   */
  async execute(args: readonly string[]): Promise<{ code: number; output: unknown }> {
    const command = parseLedgerArgs(args)
    switch (command.command) {
      case 'today': return { code: 0, output: await this.today() }
      case 'query': return { code: 0, output: await this.query(command.query) }
      case 'export': {
        if (!command.format || !command.outputPath) throw new Error('Export requires format and output')
        return { code: 0, output: await this.export({ query: command.query, format: command.format, outputPath: command.outputPath }) }
      }
      case 'merge': {
        const merged = mergeLedger(await Promise.all(command.inputs.map(readLedgerExport)))
        if (!command.outputPath) throw new Error('Merge requires output')
        if (!merged.conflicts.length) await writeExport(merged.snapshot, 'jsonl', command.outputPath)
        return { code: merged.conflicts.length ? 2 : 0, output: merged }
      }
      case 'verify': {
        const input = command.inputs[0]
        if (!input) throw new Error('Verify requires input')
        const source = await readLedgerExport(input)
        const output = verifyLedger(source, source.asOf, this.freshnessMs)
        return { code: output.valid ? 0 : 2, output }
      }
      case 'live': {
        const source = await this.source()
        return { code: 0, output: liveSessions(selectLedger(source, command.query).snapshot, Date.now(), this.freshnessMs) }
      }
      case 'cache': {
        const source = await this.source()
        return { code: 0, output: cacheRemaining(source, Date.now(), command.query) }
      }
    }
  }
}

export default LedgerQueryService
