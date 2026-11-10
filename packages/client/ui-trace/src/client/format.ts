/** Pure text used by the panel and by file export. */
import type { DecisionRevision, TraceEvent, TraceItem, TraceReference, TraceSource } from '@panedesk/dsh-trace-store/types'
import type { TraceKey } from './locales.ts'

/** Localized labels the formatters need. */
export type TraceText = (key: TraceKey, values?: Record<string, string | number>) => string

/** Who recorded one row, in the current language.
 * @param source Automatic attribution stored with the row.
 * @param t Localized copy.
 * @returns Actor, model, and local time.
 */
export function sourceLine(source: TraceSource, t: TraceText): string {
  const actor = source.actor === 'user' ? t('actorUser')
    : source.actor === 'planner' ? t('actorPlanner')
      : source.actor === 'subagent' ? t('actorSubagent')
        : t('actorExecutor')
  return t('recordedBy', {
    actor: source.sessionId === null ? actor : `${actor} ${source.sessionId}`,
    model: source.model ?? t('modelUnknown'),
    time: new Date(source.time).toLocaleString(),
  })
}

/** Item status label.
 * @param status Stored item status.
 * @param t Localized copy.
 * @returns Status word.
 */
export function itemStatus(status: TraceItem['status'], t: TraceText): string {
  return status === 'open' ? t('statusOpen') : status === 'closed' ? t('statusClosed') : t('statusVoid')
}

/** Decision status label.
 * @param status Stored revision status.
 * @param t Localized copy.
 * @returns Status word.
 */
export function decisionStatus(status: DecisionRevision['status'], t: TraceText): string {
  return status === 'active' ? t('statusActive')
    : status === 'proposed' ? t('statusProposed')
      : status === 'rejected' ? t('statusRejected')
        : t('statusReverted')
}

/** One activity line: who, which model, when, and the recorded type.
 * @param event Timeline row.
 * @param t Localized copy.
 * @returns One readable line.
 */
export function eventLine(event: TraceEvent, t: TraceText): string {
  return `${sourceLine(event.source, t)} · ${event.type}`
}

/** Markdown export of one item, its timeline, and the decisions that name it.
 * @param item Selected item.
 * @param events Item timeline.
 * @param refs References attached to those events.
 * @param decisions Decision revisions that name this item.
 * @param t Localized copy.
 * @returns Markdown text.
 */
export function itemMarkdown(
  item: TraceItem, events: readonly TraceEvent[], refs: readonly TraceReference[],
  decisions: readonly DecisionRevision[], t: TraceText,
): string {
  const lines = [`# ${item.title}`, '', `${itemStatus(item.status, t)} · ${sourceLine(item.source, t)}`, '', `## ${t('timeline')}`]
  for (const event of events) {
    lines.push(`- ${eventLine(event, t)}`)
    for (const ref of refs.filter(row => row.eventId === event.id)) lines.push(`  - ${ref.summary}`)
  }
  lines.push('', `## ${t('decisions')}`)
  for (const row of decisions) lines.push(`- ${row.title} (${decisionStatus(row.status, t)}, v${row.revision}): ${row.body}`)
  return `${lines.join('\n')}\n`
}
