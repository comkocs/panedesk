/** Category tables shared by the tree, monitoring dialog and composer dock. */
import type { ActivitySummary, ActivityTotal } from '@panedesk/dsh-activity-category/types'
import type { PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { SubagentTreeNode } from '../types.ts'
import type { SubagentTreeKey } from './locales.ts'
import css from './panel.module.css'

type Copy = PropsLocale<'subagentTree'>['t']

/** Format elapsed operation milliseconds as minutes and seconds.
 * @param milliseconds Observed duration.
 * @returns Zero-padded mm:ss, without limiting the minutes.
 */
export function activityTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/** Render one category total table; script tags overlap the primary denominator.
 * @param props Observed totals and typed localization.
 * @returns A table retained after task completion, or an explicit unknown.
 */
export function ActivityTable({ totals, t }: { totals: readonly ActivityTotal[] | undefined; t: Copy }) {
  if (totals === undefined) return <p>{t('unknown')}</p>
  return <table className={css.table}>
    <thead><tr><th>{t('activityCategory')}</th><th>{t('activityCount')}</th><th>{t('activityTime')}</th><th>{t('activityShare')}</th></tr></thead>
    <tbody>{totals.map(row => <tr key={row.category}>
      <td>{t(`category.${row.category}`)}</td><td>{row.count}</td><td>{activityTime(row.durationMs)}</td><td>{(row.share * 100).toFixed(1)}%</td>
    </tr>)}</tbody>
  </table>
}

/** Display current execution, or the latest completed category while idle.
 * @param props Latest task and localized copy.
 * @returns One compact activity cell.
 */
export function ActivityCell({ activity, t }: { activity: ActivitySummary | null | undefined; t: Copy }) {
  const current = activity?.current
  if (!current) return <>{t('unknown')}</>
  const category = t(`category.${current.category}`) + (current.selfWrittenScript && current.category !== 'script' ? ` + ${t('category.script')}` : '')
  return <>{t(current.active ? 'activityNow' : 'activityLast', { category, time: activityTime(current.durationMs) })}</>
}

/** Add native node totals without including external registry entries.
 * @param nodes Nodes already flattened once by the tree renderer.
 * @returns Whole-tree category totals with a common primary-time denominator.
 */
export function treeActivityTotals(nodes: readonly SubagentTreeNode[]): ActivityTotal[] {
  const totals = new Map<ActivityTotal['category'], ActivityTotal>()
  let duration = 0
  for (const node of nodes) {
    if (node.external || !node.activity) continue
    duration += node.activity.totalMs
    for (const row of node.activity.totals) {
      const sum = totals.get(row.category) ?? { category: row.category, count: 0, durationMs: 0, share: 0 }
      sum.count += row.count; sum.durationMs += row.durationMs
      totals.set(row.category, sum)
    }
  }
  return [...totals.values()].map(row => ({ ...row, share: duration === 0 ? 0 : row.durationMs / duration }))
}

/** Parent session table beside the existing context meter, using the same tree resource.
 * @param props Standard composer-dock hooks and localized copy.
 * @returns Expandable task activity table.
 */
export function ParentActivity({ sessionId, useResource, t }: PropsRuntime<'conversation.composer.dock'> & PropsLocale<'subagentTree'>) {
  const resource = useResource<'subagenttree'>(`dsh-resource://subagenttree/session/${encodeURIComponent(sessionId)}`)
  const message: SubagentTreeKey = resource.status === 'failed' ? 'error' : 'loading'
  return <details className={css.activityDock}>
    <summary>{t('activityTotals')}</summary>
    {resource.value ? <ActivityTable totals={resource.value.root.activity?.totals} t={t} /> : <p>{t(message)}</p>}
    <p>{t('activityNote')}</p>
  </details>
}
