/** Owner-authorized read-only statistics over the public session ledger. */
import type { Context, Volatile } from '@panedesk/cordis'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import type {} from '@panedesk/dsh-config-editor'
import type {} from '@panedesk/dsh-settings'
import type {} from '@panedesk/dsh-ledger-query'
import type { StatsRequest, StatsView } from '@panedesk/dsh-ledger-query/types'
import Schema from '@panedesk/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import type {} from './types.ts'

/** Explicit statistics availability and refresh cadence. */
export interface Config {
  /** Permit authenticated owners to read aggregate and call projections. */
  enabled: Volatile<boolean>
  /** Client resource refresh interval in milliseconds. */
  refreshIntervalMs: Volatile<number>
}

declare module '@panedesk/cordis' {
  interface Context { stats: StatsService }
}

/** No write, export, transcript, model, or caller-supplied identity capability is exposed. */
export default class StatsService extends TypertRemoteService {
  static Config = Schema.object({
    enabled: Schema.boolean().default(true).volatile(),
    refreshIntervalMs: Schema.number().min(1000).max(2147483647).step(1).default(10000).volatile(),
  })
  private readonly lifetime = new AbortController()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'stats')
    ctx.effect(() => () => { this.lifetime.abort() })
    ctx.inject(['settings'], (scope) => { scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)) })
  }

  /** Describe storage and configuration without reading usage, including while disabled.
   * @returns Absolute profile and local journal paths, or null for an unknown provider.
   */
  @Remote
  locations(): { configFile: string | null; configDirectory: string | null; dataDirectory: string | null } {
    const editor = this.ctx.get('configEditor')
    const configFile = editor?.documentPath ?? null
    const entry = editor?.entries().find(row => row.options.name === '@panedesk/dsh-session-ledger')
    const config: unknown = entry?.fiber?.config
    const home = typeof config === 'object' && config !== null && 'dshHome' in config && typeof config.dshHome === 'string'
      ? config.dshHome : undefined
    return { configFile, configDirectory: configFile === null ? null : dirname(configFile),
      dataDirectory: entry === undefined ? null : join(resolveDshHome(home), 'ledger', 'v1') }
  }

  /** Read one deduplicated ledger snapshot from the installed query provider.
   * @param request - Fixed time range, bucket, grouping and optional attribution filters.
   * @returns Coverage-aware projection plus the deployment's current refresh cadence.
   */
  @Remote
  async read(request: StatsRequest): Promise<{ view: StatsView; refreshIntervalMs: number }> {
    if (!this.config.enabled.get()) throw new RemoteError('stats/disabled', 'Statistics are disabled', {})
    const invocationSignal = this.ctx.invocation?.signal
    const cancelled = () => this.lifetime.signal.aborted || invocationSignal?.aborted
    if (cancelled()) throw new RemoteError('stats/unavailable', 'Statistics are unavailable', {})
    const query = this.ctx.get('ledgerQuery')
    if (!query) throw new RemoteError('stats/unavailable', 'Ledger queries are unavailable', {})
    const view = await query.stats(request)
    if (cancelled()) {
      throw new RemoteError('stats/unavailable', 'Statistics are unavailable', {})
    }
    return { view, refreshIntervalMs: this.config.refreshIntervalMs.get() }
  }
}
