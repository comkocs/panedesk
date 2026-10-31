/**
 * Cache pill plugin, browser half: one `conversation.composer.dock` entry after
 * the shipped activity and usage pills. It reads the host cache bridge and,
 * for an explicit route only, stores a tier the route supports.
 * @module @panedesk/dsh-client-ui-cache-pill/client
 */
import type { Context as ClientContext } from '@panedesk/cordis'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { SessionCacheRemainingRow } from '@panedesk/dsh-llm-cache/types'
import type {} from '@panedesk/dsh-api-remotes/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import { cacheProvider } from './resource.ts'
import type {} from '@panedesk/dsh-client-resources/client'
import { CachePill } from './CachePill.tsx'
import { en, zh } from './locales.ts'
import type { CacheRead, CacheTier } from './view.ts'

export type { CachePillKey } from './locales.ts'
export type { CachePillInjected, CachePillProps } from './CachePill.tsx'
export type { CacheRead, CacheRow, CacheTier, TierWrite } from './view.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'cachePill'

/** Required services: the slot registry, the Session Remote, and the copy. */
export const inject = ['slots', 'remote', 'remote.cacheView', 'locale', 'resources']

/** A tier the bridge accepts storing. */
function isTier(value: string): value is CacheTier {
  return value === 'none' || value === '5m' || value === '1h' || value === '30m' || value === '12h'
}

/**
 * Client plugin body: the dock pill and its dictionaries.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-cache-pill: dictionaries')
  const read = async (sessionId: SessionId): Promise<CacheRead> => {
    const result = await ctx.remote.cacheView.read({ sessionId })
    if (!result.ok) return { status: result.error.code === 'session/not-found' || result.error.code === 'remote-access/denied' ? 'denied' : 'error' }
    const view = result.value
    // A successful read with no rows is an empty ledger, not a failed read.
    if (view.rows.length === 0) return { status: 'empty' }
    const retention = view.retention !== undefined && isTier(view.retention) ? view.retention : undefined
    return {
      status: 'ready',
      complete: view.complete,
      rows: view.rows.map((row: SessionCacheRemainingRow) => ({
        sessionId: row.sessionId, role: row.role, kind: row.kind,
        ...row.kind === 'estimated' ? { seconds: row.seconds, evidenceAt: row.evidenceAt, ttlSeconds: row.ttlSeconds } : {},
        ...row.cacheReadTokens === undefined ? {} : { cacheReadTokens: row.cacheReadTokens },
      })),
      tiers: view.tiers.filter(isTier),
      ...retention === undefined ? {} : { retention },
    }
  }
  ctx.effect(() => ctx.resources.register(cacheProvider(read)), 'ui-cache-pill: evidence resource')
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'cache',
    order: 2,
    locale: NS,
    inject: (sessionId: SessionId) => ({
      write: async (tier: CacheTier): Promise<boolean> => {
        const result = await ctx.remote.cacheView.setTier({ sessionId, retention: tier })
        return result.ok
      },
    }),
  }, CachePill))
}
