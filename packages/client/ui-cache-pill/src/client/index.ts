/**
 * Cache pill plugin, browser half: one `conversation.composer.dock` entry after
 * the shipped activity and usage pills, registered only while the visibility
 * preference is on. It reads the host cache bridge and, for an explicit route
 * only, stores a tier the route supports.
 * @module @panedesk/dsh-client-ui-cache-pill/client
 */
import type { Context as ClientContext } from '@panedesk/cordis'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { SessionCacheRemainingRow } from '@panedesk/dsh-llm-cache/types'
import type {} from '@panedesk/dsh-api-remotes/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import { cacheProvider } from './resource.ts'
import type {} from '@panedesk/dsh-client-resources/client'
import { CachePill } from './CachePill.tsx'
import { CachePillSettingRow } from './CachePillSettingRow.tsx'
import type { CachePillSettingFace, PillVisibility } from './CachePillSettingRow.tsx'
import { en, zh } from './locales.ts'
import type { CacheRead, CacheTier } from './view.ts'

export type { CachePillKey } from './locales.ts'
export type { CachePillInjected, CachePillProps } from './CachePill.tsx'
export type { CacheRead, CacheRow, CacheTier, TierWrite } from './view.ts'
export type { CachePillSettingFace, PillVisibility }

/** Dictionary namespace owned by this plugin. */
const NS = 'cachePill'

/** Settings namespace of this plugin's visibility preference. */
const SETTINGS_NAMESPACE = 'ui-cache-pill'

/** Required services: the slot registry, the Session Remote, the copy, and the settings forms. */
export const inject = ['slots', 'remote', 'remote.cacheView', 'locale', 'resources', 'configForms']

/** A tier the bridge accepts storing. */
function isTier(value: string): value is CacheTier {
  return value === 'none' || value === '5m' || value === '1h' || value === '30m' || value === '12h'
}

/**
 * Client plugin body: the dock pill while visible, its dictionaries, and the
 * feature-settings row that toggles it.
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
  const visibility = ctx.configForms.get<PillVisibility>(SETTINGS_NAMESPACE)
  ctx.effect(() => {
    let disposeDock: (() => void) | undefined
    const sync = (): void => {
      const show = visibility.getSnapshot().value?.visible === true
      if (show === (disposeDock !== undefined)) return
      if (!show) {
        const stop = disposeDock
        disposeDock = undefined
        stop?.()
        return
      }
      disposeDock = ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
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
    sync()
    const unsubscribe = visibility.subscribe(sync)
    return () => {
      unsubscribe()
      const stop = disposeDock
      disposeDock = undefined
      stop?.()
    }
  }, 'ui-cache-pill: dock pill follows the visibility preference')
  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NAMESPACE], () =>
    ctx.slots.inject('settings.panedesk.item', () => ctx.slots.register({
      name: 'settings.panedesk.item',
      id: 'cache-pill',
      order: 40,
      locale: NS,
      inject: (): CachePillSettingFace => ({
        hooks: { visibility },
        setEnabled: enabled => visibility.set('visible', enabled),
      }),
    }, CachePillSettingRow))), 'ui-cache-pill: feature settings row')
}
