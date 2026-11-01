/** Composer dock pill listing cache time left, with a tier switch only for an explicit route. */
import { useEffect, useState, type ReactNode } from 'react'
import { IconClockOutlineRegular } from '@panedesk/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { CachePillKey } from './locales.ts'
import { remainingParts, type CacheRead, type CacheRow, type CacheTier, type TierWrite } from './view.ts'
import css from './CachePill.module.css'

/** Reads and writes the pill closes over. */
export interface CachePillInjected {
  /**
   * Store a tier for the current window.
   * @param tier - one tier the latest read offered.
   * @returns whether the host stored it.
   */
  write(this: void, tier: CacheTier): Promise<boolean>
}

/** Props of the dock entry: the slot runtime, this namespace, and the bridge. */
export type CachePillProps =
  & PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'cachePill'>
  & CachePillInjected

const TIER_KEY: Record<CacheTier, CachePillKey> = {
  'none': 'tier.none', '5m': 'tier.5m', '1h': 'tier.1h', '30m': 'tier.30m', '12h': 'tier.12h',
}

/** The pill's own reading, taken from the main window's row. */
function pillText(read: CacheRead, t: (key: CachePillKey, values?: Record<string, string>) => string): string {
  if (read.status !== 'ready') return t('pill.label')
  const main = read.rows.find(row => row.role === 'main')
  if (main === undefined) return t('pill.unknown')
  if (main.kind === 'estimated' && main.seconds !== undefined) {
    const parts = remainingParts(main.seconds)
    return t('pill.estimated', { time: t(`time.${parts.key}`, parts.values) })
  }
  if (main.kind === 'automatic') return t('pill.automatic')
  if (main.kind === 'disabled') return t('pill.disabled')
  return t('pill.unknown')
}

/** One window's line in the panel. */
function rowText(row: CacheRow, t: (key: CachePillKey, values?: Record<string, string>) => string): string {
  if (row.kind === 'estimated' && row.seconds !== undefined) {
    const parts = remainingParts(row.seconds)
    return t('panel.kind.estimated', { time: t(`time.${parts.key}`, parts.values) })
  }
  if (row.kind === 'automatic') return row.cacheReadTokens === undefined
    ? t('panel.hitsUnknown') : t('panel.hits', { count: String(row.cacheReadTokens) })
  if (row.kind === 'disabled') return t('panel.kind.disabled')
  return t('panel.kind.unknown')
}

/** Status line for a read that is not ready, or nothing when it is. */
function statusLine(read: CacheRead, t: (key: CachePillKey) => string): string | undefined {
  if (read.status === 'loading') return t('panel.loading')
  if (read.status === 'error') return t('panel.error')
  if (read.status === 'denied') return t('panel.denied')
  if (read.status === 'unavailable') return t('panel.unavailable')
  if (read.status === 'empty') return t('panel.empty')
  return undefined
}

/**
 * The cache pill. Closed, it shows the main window's reading; open, it lists every window
 * and, only for an explicit route, the tiers that route supports.
 * @param props - slot runtime, copy, and the host bridge.
 * @returns the pill and its open panel, or null for the minimal preset.
 */
export function CachePill({ t, sessionId, useSessions, useResource, write }: CachePillProps): ReactNode {
  const minimal = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset === 'minimal')
  const [open, setOpen] = useState(false)
  const resource = useResource<'sessioncache'>(`dsh-resource://sessioncache/${encodeURIComponent(sessionId)}`)
  const view: CacheRead = resource.status === 'failed' ? { status: 'error' } : resource.value ?? { status: 'loading' }
  const [tier, setTier] = useState<TierWrite>({ status: 'idle' })
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [])
  const current = view.status !== 'ready' ? view : {
    ...view,
    rows: view.rows.map(row => row.kind !== 'estimated' || row.evidenceAt === undefined || row.ttlSeconds === undefined
      ? row : { ...row, seconds: Math.max(0, Math.floor((row.evidenceAt + row.ttlSeconds * 1000 - now) / 1000)) }),
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
  }

  const choose = (next: CacheTier) => {
    setTier({ status: 'pending' })
    void write(next).then((saved) => {
      setTier({ status: saved ? 'saved' : 'failed' })
    }, () => { setTier({ status: 'failed' }) })
  }

  const note = statusLine(view, t)
  if (minimal) return null
  return (
    <span className={css.anchor}>
      <button type="button" className={css.pill} aria-expanded={open} onClick={toggle}>
        <IconClockOutlineRegular />
        <span>{pillText(current, t)}</span>
      </button>
      {open
        ? (
          <span className={css.panel} role="dialog" aria-label={t('panel.title')}>
            {note !== undefined ? <span className={css.muted}>{note}</span> : null}
            {view.status === 'ready'
              ? (current.status === 'ready' ? current.rows : []).map(row => (
                <span key={row.sessionId} className={css.row}>
                  <span>{row.role === 'main' ? t('panel.main') : t('panel.subagent', { id: row.sessionId })}</span>
                  <span>{rowText(row, t)}</span>
                </span>
              ))
              : null}
            {view.status === 'ready' && view.complete === false ? <span className={css.muted}>{t('panel.partial')}</span> : null}
            {view.status === 'ready' && view.tiers.length > 0
              ? (
                <span className={css.tiers} role="group" aria-label={t('tier.label')}>
                  {view.tiers.map(item => (
                    <button
                      key={item}
                      type="button"
                      className={css.tier}
                      aria-pressed={view.retention === item}
                      disabled={tier.status === 'pending'}
                      onClick={() => { choose(item) }}
                    >
                      {t(TIER_KEY[item])}
                    </button>
                  ))}
                </span>
              )
              : null}
            {tier.status === 'pending' ? <span className={css.muted}>{t('tier.pending')}</span> : null}
            {tier.status === 'saved' ? <span className={css.muted}>{t('tier.saved')}</span> : null}
            {tier.status === 'failed' ? <span className={css.muted}>{t('tier.failed')}</span> : null}
          </span>
        )
        : null}
    </span>
  )
}
