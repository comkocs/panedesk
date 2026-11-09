/** Composer occupancy control and provider-aligned, display-only context composition. */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { UseProjection } from '@panedesk/dsh-api-session-controller/client'
import type { ContextBreakdownProjection } from '@panedesk/dsh-token-meter/client'
import { Tooltip, useAnchoredPosition, useDismissOnOutsidePointer } from '@panedesk/dsh-client-ui-primitives'
import type { ComposerBarProps } from '../contract/slots.ts'
import { contextOccupancy } from '../context-occupancy.ts'
import css from './ContextMeter.module.css'

const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const ROWS = [
  { key: 'messageTokens', label: 'context.messages', color: css.colorMessages },
  { key: 'mcpToolsTokens', label: 'context.mcpTools', color: css.colorMcp, group: 'mcpTools' },
  { key: 'systemTokens', label: 'context.system', color: css.colorSystem },
  { key: 'builtinToolsTokens', label: 'context.builtinTools', color: css.colorTools, group: 'builtinTools' },
  { key: 'skillsTokens', label: 'context.skills', color: css.colorTools, group: 'skills' },
  { key: 'memoryTokens', label: 'context.memory', color: css.colorTools, group: 'memory' },
  { key: 'agentsTokens', label: 'context.agents', color: css.colorTools, group: 'agents' },
  { key: 'mcpInstructionsTokens', label: 'context.mcpInstructions', color: css.colorTools },
] as const
const DEFERRED = [
  { key: 'deferredMcpTokens', label: 'context.deferredMcp' },
  { key: 'deferredBuiltinTokens', label: 'context.deferredBuiltin' },
] as const

/** Format approximate token counts using the locale's compact-number units. */
function formatTokens(value: number, t: ComposerBarProps['t']): string {
  const scaled = (candidate: number): string => String(Math.round(candidate * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return t('number.thousand', { value: scaled(value / 1_000) })
  return t('number.million', { value: scaled(value / 1_000_000) })
}

export interface ContextMeterProps {
  useProjection: UseProjection
  t: ComposerBarProps['t']
  openToolSettings: ComposerBarProps['openToolSettings']
}

export function ContextMeter({ useProjection, t, openToolSettings }: ContextMeterProps) {
  const pressure = useProjection('contextPressure')
  const breakdown = useProjection('contextBreakdown')
  const compaction = useProjection('contextCompaction')
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<keyof ContextBreakdownProjection['items'] | null>(null)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const context = contextOccupancy(pressure)
  const available = context !== null
  const position = useAnchoredPosition({
    open: open && available, anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12,
  })
  useDismissOnOutsidePointer(rootRef, open && available, setOpen, panelRef)

  useEffect(() => {
    if (!available && open) setOpen(false)
  }, [available, open])

  useEffect(() => {
    if (!open || !available) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [available, open])

  if (context === null) return null
  const window = context.contextWindow
  const weights = breakdown?.sampled ?? breakdown
  const localTotal = ROWS.reduce((sum, row) => sum + (breakdown?.[row.key] ?? 0), 0)
  const sampledTotal = ROWS.reduce((sum, row) => sum + (weights?.[row.key] ?? 0), 0)
  const reported = pressure?.pressureTokens ?? 0
  // Shrinking a retained surface reduces the anchored categories; positive movement is its own row.
  const used = Math.max(0, reported + localTotal - sampledTotal)
  const anchored = Math.min(reported, used)
  let cumulative = 0
  let assigned = 0
  const categories = ROWS.map(row => {
    cumulative += weights?.[row.key] ?? 0
    const end = sampledTotal === 0
      ? row.key === 'systemTokens' ? anchored : assigned
      : Math.round(anchored * cumulative / sampledTotal)
    const tokens = end - assigned
    assigned = end
    return { ...row, tokens }
  })
  const since = used - anchored
  const reserve = compaction?.reserveTokens ?? 0
  const free = window - used - reserve
  const rows = [
    ...categories,
    { key: 'since', label: 'context.since', color: css.colorTools, tokens: since },
    { key: 'reserve', label: 'context.reserve', color: css.colorReserve, tokens: reserve },
    { key: 'free', label: 'context.free', color: css.colorFree, tokens: free },
  ] as const
  const percent = (used / window * 100).toFixed(1)
  const reading = `${percent}%`
  const percentage = (tokens: number): string => `${(tokens / window * 100).toFixed(1)}%`

  return (
    <span ref={rootRef} className={css.root}>
      <Tooltip label={t('context.aria', { percent: reading })} side="top" delayMs={200} disabled={open}>
        <button type="button" className={css.trigger} aria-label={t('context.aria', { percent: reading })}
          aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(!open) }}>
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
            <circle className={css.track} cx="7" cy="7" r={RADIUS} />
            <circle className={css.fill} cx="7" cy="7" r={RADIUS}
              strokeDasharray={`${CIRCUMFERENCE * Math.min(100, Number(percent)) / 100} ${CIRCUMFERENCE}`}
              transform="rotate(-90 7 7)" />
          </svg>
          <span>{reading}</span>
        </button>
      </Tooltip>
      {open && createPortal(
        <div ref={panelRef} className={css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }} role="dialog" aria-label={t('context.title')}>
          <div className={css.title}>{t('context.title')}</div>
          <div className={css.header}>
            <span className={css.percent}>{t('context.used', { percent: reading })}</span>
            <span className={css.figures}>{`~${formatTokens(used, t)} / ${formatTokens(window, t)}`}</span>
          </div>
          <div className={css.bar}>
            {rows.filter(row => row.tokens > 0).map(row => (
              <div key={row.key} className={`${css.segment} ${row.color}`} style={{ width: percentage(row.tokens) }} />
            ))}
          </div>
          <dl className={css.rows}>
            {rows.map(row => (
              <div key={row.key} className={css.row}>
                <dt><span className={`${css.swatch} ${row.color}`} aria-hidden />
                  {'group' in row
                    ? <button type="button" className={css.category} aria-expanded={expanded === row.group}
                        onClick={() => { setExpanded(expanded === row.group ? null : row.group) }}>{t(row.label)}</button>
                    : t(row.label)}
                </dt>
                <dd title={`~${row.tokens}`}>{`~${formatTokens(row.tokens, t)}`}</dd>
                <dd>{percentage(row.tokens)}</dd>
              </div>
            ))}
            {DEFERRED.map(row => (
              <div key={row.key} className={css.row}>
                <dt><span className={`${css.swatch} ${css.colorReserve}`} aria-hidden />{t(row.label)}</dt>
                <dd>{`~${formatTokens(breakdown?.[row.key] ?? 0, t)}`}</dd><dd>—</dd>
              </div>
            ))}
          </dl>
          {categories.filter(row => 'group' in row).map(row => {
            if (!('group' in row)) return null
            const items = breakdown?.items[row.group] ?? []
            const total = items.reduce((sum, item) => sum + (item.deferred ? 0 : item.tokens), 0)
            let itemCumulative = 0
            let itemAssigned = 0
            return (
              <details key={row.group} className={css.group} open={expanded === row.group}>
                <summary onClick={event => {
                  event.preventDefault()
                  setExpanded(expanded === row.group ? null : row.group)
                }}>{t(row.label)}<span>{items.length}</span></summary>
                {row.group === 'builtinTools' && <button type="button" className={css.settings}
                  onClick={() => { setOpen(false); openToolSettings() }}>{t('context.toolSettings')}</button>}
                <ul className={css.items}>
                  {items.map(item => {
                    itemCumulative += item.deferred ? 0 : item.tokens
                    const end = total === 0 ? 0 : Math.round(row.tokens * itemCumulative / total)
                    const tokens = item.deferred ? item.tokens : end - itemAssigned
                    if (!item.deferred) itemAssigned = end
                    return <li key={item.name}><span>{item.name}{item.deferred ? ` (${t('context.deferred')})` : ''}</span>
                      <span title={`~${tokens}`}>{`~${formatTokens(tokens, t)}`}</span></li>
                  })}
                </ul>
              </details>
            )
          })}
        </div>, document.body,
      )}
    </span>
  )
}
