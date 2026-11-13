/** Pure text used by the panel and by file export. */
import type { SessionEvent } from '@panedesk/dsh-session/types'
import type { DecisionRevision, ReferenceContent, TraceEvent, TraceItem, TraceReference, TraceSource } from '@panedesk/dsh-trace-store/types'
import type { TraceKey } from './locales.ts'

/** Localized labels the formatters need. */
export type TraceText = (key: TraceKey, values?: Record<string, string | number>) => string

/** Who recorded one row, in the current language.
 * @param source Automatic attribution stored with the row.
 * @param t Localized copy.
 * @returns Actor, model, and local time.
 */
export function sourceLine(source: TraceSource, t: TraceText): string {
  const actor = actorName(source.sessionId !== null && source.actor === 'user' ? 'executor' : source.actor, t)
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

/** One activity sentence: what happened, without the raw event type.
 * @param event Timeline row.
 * @param t Localized copy.
 * @returns One readable line. The stored type stays available as {@link eventType}.
 */
export function eventLine(event: TraceEvent, t: TraceText): string {
  const who = event.source.sessionId === null ? actorName(event.source.actor, t) : sessionName(event, t)
  return `${who} ${eventAction(event, t)}`
}

/** Stored event type, shown on hover rather than in the line.
 * @param event Timeline row.
 * @returns The recorded type string.
 */
export function eventType(event: TraceEvent): string {
  return event.type
}

/** Actor word without a session id.
 * @param actor Stored actor.
 * @param t Localized copy.
 * @returns Actor label.
 */
function actorName(actor: TraceSource['actor'], t: TraceText): string {
  return actor === 'user' ? t('actorUser')
    : actor === 'planner' ? t('actorPlanner')
      : actor === 'subagent' ? t('actorSubagent')
        : t('actorExecutor')
}

/** Window label used in an activity sentence.
 * @param event Timeline row.
 * @param t Localized copy.
 * @returns Localized window name.
 */
function sessionName(event: TraceEvent, t: TraceText): string {
  const id = event.source.sessionId ?? event.sessionId ?? ''
  return event.source.actor === 'subagent' ? t('subagentNamed', { name: id }) : t('windowNamed', { name: id })
}

/** Read a string field out of an event payload.
 * @param payload Stored JSON text.
 * @param key Field name.
 * @returns The string, or undefined when the payload is not that object.
 */
function payloadText(payload: string, key: string): string | undefined {
  try {
    const value: unknown = JSON.parse(payload)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const field = (value as Record<string, unknown>)[key]
    return typeof field === 'string' && field.length > 0 ? field : undefined
  } catch { return undefined }
}

/** What the row records, as one clause.
 * @param event Timeline row.
 * @param t Localized copy.
 * @returns The action clause.
 */
function eventAction(event: TraceEvent, t: TraceText): string {
  const summary = payloadText(event.payload, 'summary')
  if (event.type === 'file/changed') {
    if (summary?.startsWith('created ')) return t('createdFile', { summary: summary.slice(8) })
    return t('changedFile', { summary: summary?.replace(/^edited /, '') ?? t('changedUnknown') })
  }
  if (event.type === 'workspace/changes') {
    const payload = JSON.parse(event.payload) as { files: { path: string }[] }
    return t('changedFile', { summary: payload.files.map(file => file.path).join(', ') })
  }
  if (event.type === 'tool/call') return t('ranCommand', { summary: summary ?? '' })
  if (event.type === 'user/message') return t('saidSomething')
  if (event.type === 'assistant/message') {
    const reply = payloadText(event.payload, 'text')?.slice(0, 30)
    return reply === undefined ? t('replied') : t('repliedWith', { summary: reply })
  }
  if (event.type === 'session/started') return t('started')
  if (event.type === 'session/ended') return t('ended')
  if (event.type === 'session/linked') return t('linkedSession')
  if (event.type === 'item/created') return t('createdItem', { title: payloadText(event.payload, 'title') ?? '' })
  if (event.type === 'comment/created') return t('commented')
  if (event.type === 'subagent/start') return t('subagentStarted')
  if (event.type === 'subagent/end') return t('subagentEnded')
  if (event.type === 'turn/start') return t('turnStarted')
  if (event.type === 'turn/end') return t('turnEnded')
  if (event.type === 'deliverables/presented') return t('presented')
  return t('recorded', { type: event.type })
}

/** Render stored comparisons as diff lines and messages as visible text only.
 * @param content Selected reference and its stored source text.
 * @returns Readable content without assistant reasoning.
 */
export function referenceText(content: ReferenceContent): string {
  if (content.reference.kind === 'change') {
    const diff = JSON.parse(content.text) as { kind: string; path: string; hunks?: { lines: string[] }[] }
    return diff.kind === 'text' ? `${diff.path}\n${diff.hunks!.flatMap(hunk => hunk.lines).join('\n')}` : diff.path
  }
  if (content.reference.kind !== 'session-slice') return content.text
  const events = JSON.parse(content.text) as string | SessionEvent[]
  if (typeof events === 'string') return events
  return events.map(event => {
    if (event.type === 'assistant/message' || event.type === 'user/message') {
      const message = event.type === 'assistant/message' ? event.data.message : event.data
      return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    }
    if (event.type === 'tool/call' && event.data.name === 'bash') {
      return (JSON.parse(event.data.arguments) as { command: string }).command
    }
    return JSON.stringify(event)
  }).join('\n')
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
