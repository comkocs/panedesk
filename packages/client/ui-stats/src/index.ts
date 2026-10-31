/** Owner-authorized read-only statistics over the public session ledger. */
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-ledger-query'
import type { StatsRequest, StatsView } from '@panedesk/dsh-ledger-query/types'
import Schema from '@panedesk/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import type {} from './types.ts'

/** Explicit statistics availability and refresh cadence. */
export interface Config {
  /** Permit authenticated owners to read aggregate and call projections. */
  enabled: boolean
  /** Client resource refresh interval in milliseconds. */
  refreshIntervalMs: number
}

declare module '@panedesk/cordis' {
  interface Context { stats: StatsService }
}

/** No write, export, transcript, model, or caller-supplied identity capability is exposed. */
export default class StatsService extends TypertRemoteService {
  static Config: Schema<Config> = Schema.object({
    enabled: Schema.boolean().default(true),
    refreshIntervalMs: Schema.number().min(1000).max(2147483647).step(1).default(10000),
  })
  private readonly lifetime = new AbortController()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'stats')
    ctx.effect(() => () => { this.lifetime.abort() })
  }

  /** Read one deduplicated ledger snapshot after authenticating the invocation owner.
   * @param request - Fixed time range, bucket, grouping and optional attribution filters.
   * @returns Five-tab projection plus the deployment's refresh cadence.
   */
  @Remote
  async read(request: StatsRequest): Promise<{ view: StatsView; refreshIntervalMs: number }> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('stats/unauthorized', 'Authenticated owner required', {})
    }
    if (!this.config.enabled) throw new RemoteError('stats/disabled', 'Statistics are disabled', {})
    const invocationSignal = this.ctx.invocation.signal
    const cancelled = () => this.lifetime.signal.aborted || invocationSignal.aborted
    if (cancelled()) throw new RemoteError('stats/unavailable', 'Statistics are unavailable', {})
    const query = this.ctx.get('ledgerQuery')
    if (!query) throw new RemoteError('stats/unavailable', 'Ledger queries are unavailable', {})
    const view = await query.stats(request)
    if (cancelled()) {
      throw new RemoteError('stats/unavailable', 'Statistics are unavailable', {})
    }
    return { view, refreshIntervalMs: this.config.refreshIntervalMs }
  }
}
