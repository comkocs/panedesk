/** Charts use existing ledger observations; project labels come from workspace metadata. */
import { useState, type CSSProperties } from 'react'
import { IconPanedeskStats } from '@panedesk/dsh-client-ui-panedesk-icons'
import { Button, Input, Menu, Modal, Switch, Tooltip } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { StatsSettingsActions, StatsData } from './index.ts'
import type { StatsKey } from './locales.ts'
import css from './panel.module.css'

type SettingsProps = PropsRuntime<'settings.section'> & PropsLocale<'stats'> & InjectFace<StatsSettingsActions>
type ToolsProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'stats'>
type ChartProps = Pick<ToolsProps, 'sessionId' | 'useSessions' | 'useWorkspaces' | 'useResource' | 't'>
type Call = StatsData['view']['details'][number]
const ranges = ['today', '6h', '24h', '72h', '168h', 'all'] as const
/** Per-call records stay collapsed by default and paginate at this page size. */
const pageSize = 30

function stateKey(status: string, value: StatsData | undefined, code: string | undefined): StatsKey {
  if (code === 'stats/unauthorized') return 'unauthorized'
  if (code === 'stats/disabled') return 'disabled'
  if (status === 'failed') return value ? 'failed' : 'error'
  if (status === 'loading') return 'loading'
  if (!value) return 'idle'
  if (!value.view.complete) return 'partial'
  return value.view.summary.calls === 0 ? 'empty' : 'success'
}

/** Settings writes use the shared profile form; a disabled feature can still be configured.
 * @param props - Framework-bound configuration, resource reads and native path actions.
 * @returns Description, enablement, full paths, global scope and an immediate-save interval.
 */
export function StatsSettings({ useResource, usePreferences, setPreference, openPath, t }: SettingsProps) {
  const preferences = usePreferences(value => value)
  const locations = useResource<'stats-locations'>('dsh-resource://stats-locations/current')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<StatsKey | null>(null)
  const [intervalDraft, setIntervalDraft] = useState<string | null>(null)
  const perform = async (action: () => Promise<boolean>, failure: StatsKey, success: StatsKey | null) => {
    setBusy(true); setMessage(null)
    try { setMessage(await action() ? success : failure) }
    catch (_error) { setMessage(failure) }
    finally { setBusy(false) }
  }
  const value = preferences.value
  const paths = locations.value
  return <section className={css.settings}>
    <h2>{t('title')}</h2><p>{t('settingsDescription')}</p>
    <Switch label={t('enabled')} checked={value?.enabled ?? false} disabled={busy || !preferences.writable || value === undefined}
      onChange={enabled => { void perform(() => setPreference('enabled', enabled), 'saveError', 'saved') }} />
    <p>{t('defaultEnabled')}</p>
    <h3>{t('configFile')}</h3><code>{paths?.configFile ?? t('unknownLocation')}</code>
    <div className={css.controls}>
      <Button variant="outline" disabled={busy || !paths?.configFile} onClick={() => { if (paths?.configFile) void perform(() => openPath(paths.configFile!, 'open'), 'openError', null) }}>{t('openFile')}</Button>
      <Button variant="outline" disabled={busy || !paths?.configDirectory} onClick={() => { if (paths?.configDirectory) void perform(() => openPath(paths.configDirectory!, 'open'), 'openError', null) }}>{t('openDirectory')}</Button>
    </div>
    <h3>{t('dataDirectory')}</h3><code>{paths?.dataDirectory ?? t('unknownLocation')}</code><p>{t('dataNote')}</p>
    <Button variant="outline" disabled={busy || !paths?.dataDirectory} onClick={() => { if (paths?.dataDirectory) void perform(() => openPath(paths.dataDirectory!, 'open'), 'openError', null) }}>{t('openDataDirectory')}</Button>
    <h3>{t('scope')}</h3><p>{t('global')}</p>
    <label className={css.field}>{t('interval')}<Input type="number" min={1000} max={2147483647} step={1}
      value={intervalDraft ?? value?.refreshIntervalMs ?? ''} disabled={!preferences.writable || value === undefined}
      onChange={event => {
        setIntervalDraft(event.currentTarget.value)
        const interval = event.currentTarget.valueAsNumber
        if (event.currentTarget.validity.valid && Number.isSafeInteger(interval)) void perform(() => setPreference('refreshIntervalMs', interval), 'saveError', 'saved')
      }} onBlur={() => { setIntervalDraft(null) }} /></label>
    <p>{t('intervalDefault')}</p>
    {preferences.status === 'unavailable' && <p role="alert">{t('unavailableSettings')}</p>}
    {locations.status === 'failed' && <p role="alert">{t('error')}</p>}
    {message && <p role={message === 'saved' ? 'status' : 'alert'}>{t(message)}</p>}
  </section>
}

/** One icon opens the shared modal directly at the former inbox position.
 * @param props - Session-scoped framework hooks and localized labels.
 * @returns The compact trigger and charts, mounted only while open.
 */
export function StatsTools(props: ToolsProps) {
  const [open, setOpen] = useState(false)
  return <>
    <Tooltip label={props.t('title')}><Button variant="toolbar" size="sm" aria-label={props.t('title')} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true) }}><IconPanedeskStats /></Button></Tooltip>
    <Modal open={open} onClose={() => { setOpen(false) }} title={props.t('title')} closeLabel={props.t('close')} className={css.dialog!} contentClassName={css.dialogContent!}>
      {open && <StatsPanel {...props} />}
    </Modal>
  </>
}

function tokens(call: Call): number | null {
  if (call.usageState !== 'complete') return null
  const values = [call.tokens.inputTokens, call.tokens.cacheReadTokens, call.tokens.cacheWriteTokens, call.tokens.outputTokens]
  return values.some(value => value === undefined) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}
function total(calls: readonly Call[], read: (call: Call) => number | null | undefined): number | null {
  const values = calls.map(read)
  return values.some(value => value === null || value === undefined) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}
function palette(model: string): string {
  const name = model.toLowerCase()
  return name.includes('claude') ? 'blue' : name.includes('gpt') ? 'orange' : name.includes('glm') ? 'green' : name.includes('deepseek') ? 'amber' : 'pink'
}

/** Project/session filters reshape one complete snapshot without introducing another data service.
 * @param props - Existing workspace, session and ledger resource hooks.
 * @returns Number cards, model bars, parent-child call timelines and daily bars.
 */
export function StatsPanel({ sessionId, useResource, useSessions, useWorkspaces, t }: ChartProps) {
  const [range, setRange] = useState<typeof ranges[number]>('today')
  const [paused, setPaused] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [project, setProject] = useState('')
  const [selectedSession, setSelectedSession] = useState('')
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [page, setPage] = useState(0)
  const [menu, setMenu] = useState<'range' | 'project' | 'session' | null>(null)
  const sessions = useSessions(value => value.byId)
  const workspaces = useWorkspaces(value => value.items)
  const resource = useResource<'stats'>(`dsh-resource://stats/view?range=${range}&bucket=day&groupBy=model&paused=${paused}&refresh=${refresh}`)
  const view = resource.value?.view
  const rows = view?.windows ?? []
  const byId = new Map(rows.map(row => [row.sessionId, row]))
  const projectOf = (id: Call['sessionId']): string => {
    const visited = new Set<string>()
    let current: Call['sessionId'] | null = id
    while (current !== null && !visited.has(current)) {
      visited.add(current)
      const workspace = workspaces.find(item => item.sessionIds.includes(current!) || item.path === sessions[current!]?.cwd)
      if (workspace) return workspace.workspaceId
      current = byId.get(current)?.parentSessionId ?? sessions[current]?.parentId ?? null
    }
    return 'unassigned'
  }
  const descendants = (root: string): Set<string> => {
    const ids = new Set([root])
    let size: number
    do { size = ids.size; for (const row of rows) if (row.parentSessionId && ids.has(row.parentSessionId)) ids.add(row.sessionId) } while (ids.size !== size)
    return ids
  }
  const projectRows = rows.filter(row => project === '' || projectOf(row.sessionId) === project)
  const selectedIds = selectedSession === '' ? null : descendants(selectedSession)
  const visibleRows = projectRows.filter(row => selectedIds === null || selectedIds.has(row.sessionId))
  const visibleIds = new Set(visibleRows.map(row => row.sessionId))
  const calls = (view?.details ?? []).filter(call => visibleIds.has(call.sessionId))
  const modelGroups = new Map<string, Call[]>()
  const days = new Map<string, Call[]>()
  for (const call of calls) {
    modelGroups.set(call.model, [...(modelGroups.get(call.model) ?? []), call])
    const day = new Date(call.startedAt + 8 * 3600000).toISOString().slice(0, 10)
    days.set(day, [...(days.get(day) ?? []), call])
  }
  const models = [...modelGroups].map(([model, items]) => ({ model, items, tokens: total(items, tokens) }))
  const daily = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, items]) => ({ day, tokens: total(items, tokens) }))
  const maximum = Math.max(1, ...models.map(row => row.tokens ?? 0))
  const dayMaximum = Math.max(1, ...daily.map(row => row.tokens ?? 0))
  const name = (id: Call['sessionId']) => sessions[id]?.displayTitle ?? id
  const number = (value: number | null) => value === null ? t('unknown') : new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value)
  const root = selectedSession || sessionId
  const familyIds = descendants(root)
  const family = visibleRows.filter(row => familyIds.has(row.sessionId))
  const familyCalls = calls.filter(call => familyIds.has(call.sessionId))
  const time = (value: number) => new Intl.DateTimeFormat(undefined, { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(value)
  const minute = (value: number | null) => value === null ? t('unknown') : t('minutes', { value: new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 60000) })
  const cards: { key: StatsKey; value: number | null }[] = [
    { key: 'sessions', value: visibleRows.length }, { key: 'subagents', value: visibleRows.filter(row => row.parentSessionId !== null).length },
    { key: 'tokens', value: total(calls, tokens) },
  ]
  const cost = total(calls, call => call.costUsd === null ? null : Number(call.costUsd))
  const duration = total(calls, call => call.modelInFlightMs)
  if (calls.length && cost !== null) cards.push({ key: 'costUsd', value: cost })
  if (calls.length && duration !== null) cards.push({ key: 'duration', value: duration })
  const sortedCalls = [...familyCalls].sort((a, b) => a.startedAt - b.startedAt)
  const pageCount = Math.max(1, Math.ceil(sortedCalls.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pageCalls = sortedCalls.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  const pageIds = new Set(pageCalls.map(call => call.sessionId))
  const pageAgents = family.filter(row => pageIds.has(row.sessionId))
  const pageWallMax = Math.max(0, ...pageCalls.map(call => call.wallMs ?? 0))
  return <section className={css.panel}>
    <div className={css.panelHeader}>
      <p>{t('description')}</p>
      <div className={css.controls}>
        <Menu open={menu === 'range'} onClose={() => { setMenu(null) }} autoFocus selectedId={range}
          anchor={<Button variant="outline" aria-haspopup="menu" aria-expanded={menu === 'range'} onClick={() => { setMenu('range') }}>{t('range')}: {t(range)}</Button>}
          items={ranges.map(id => ({ id, label: t(id) }))} onSelect={id => { const next = ranges.find(value => value === id); if (next) setRange(next); setPage(0); setMenu(null) }} />
        <Menu open={menu === 'project'} onClose={() => { setMenu(null) }} autoFocus selectedId={project}
          anchor={<Button variant="outline" aria-haspopup="menu" aria-expanded={menu === 'project'} onClick={() => { setMenu('project') }}>{t('project')}: {project === '' ? t('all') : workspaces.find(item => item.workspaceId === project)?.title ?? t('unassigned')}</Button>}
          items={[{ id: '', label: t('all') }, ...workspaces.map(item => ({ id: item.workspaceId, label: item.title })), { id: 'unassigned', label: t('unassigned') }]}
          onSelect={id => { setProject(id); setSelectedSession(''); setPage(0); setMenu(null) }} />
        <Menu open={menu === 'session'} onClose={() => { setMenu(null) }} autoFocus selectedId={selectedSession}
          anchor={<Button variant="outline" aria-haspopup="menu" aria-expanded={menu === 'session'} onClick={() => { setMenu('session') }}>{t('session')}: {selectedSession === '' ? t('all') : name(selectedSession as Call['sessionId'])}</Button>}
          items={[{ id: '', label: t('all') }, ...projectRows.map(row => ({ id: row.sessionId, label: name(row.sessionId) }))]}
          onSelect={id => { setSelectedSession(id); setPage(0); setMenu(null) }} />
        <Button variant="outline" aria-pressed={paused} onClick={() => { setPaused(value => !value) }}>{t(paused ? 'resume' : 'pause')}</Button>
        <Button disabled={resource.status === 'loading'} onClick={() => { setRefresh(value => value + 1) }}>{t('refresh')}</Button>
      </div>
      <p role={resource.status === 'failed' ? 'alert' : 'status'} aria-live="polite">{t(stateKey(resource.status, resource.value, resource.failure?.code))}</p>
    </div>
    {view && <div className={css.panelBody}>
      <div className={css.cards}>{cards.map(card => <article key={card.key}><h3>{t(card.key)}</h3><strong>{card.key === 'duration' ? minute(card.value) : number(card.value)}</strong></article>)}</div>
      <p className={css.note}>{t('sessionCountNote')} {t('reference')} {t('projectNote')}</p>
      <div className={css.charts}>
        <figure className={css.chart}><figcaption>{t('models')}</figcaption>
          {models.map(row => <div className={css.model} key={row.model} data-palette={palette(row.model)}>
            <div className={css.rowLabel}><strong>{row.model}</strong><span>{number(row.tokens)}</span></div>
            {row.tokens !== null && <div className={css.track}><div className={css.bar} style={{ '--bar-width': `${row.tokens / maximum * 100}%` } as CSSProperties} /></div>}
            <small>{t('inputTokens')}: {number(total(row.items, call => call.tokens.inputTokens))} · {t('outputTokens')}: {number(total(row.items, call => call.tokens.outputTokens))}<br />
              {t('cacheReadTokens')}: {number(total(row.items, call => call.tokens.cacheReadTokens))} · {t('cacheWriteTokens')}: {number(total(row.items, call => call.tokens.cacheWriteTokens))}</small>
          </div>)}
          {!models.length && <p>{t('empty')}</p>}
        </figure>
        {!!daily.length && <figure className={css.chart}><figcaption>{t('trend')}</figcaption><div className={css.trend}>
          {daily.map(row => <div className={css.day} key={row.day}><span>{number(row.tokens)}</span><div className={css.columnTrack}>{row.tokens !== null && <div className={css.column} style={{ '--bar-height': `${row.tokens / dayMaximum * 100}%` } as CSSProperties} />}</div><time>{row.day}</time></div>)}
        </div></figure>}
      </div>
      <figure className={css.chart}><figcaption>{t('timeline')} — {name(root as Call['sessionId'])}</figcaption>
        <Button variant="outline" aria-expanded={recordsOpen} onClick={() => { setRecordsOpen(value => !value) }}>{t(recordsOpen ? 'hideRecords' : 'showRecords', { count: sortedCalls.length })}</Button>
        {recordsOpen && <>
          <p className={css.note}>{t('timingNote')}</p>
          {pageAgents.map(row => <article className={css.agent} key={row.sessionId}>
            <h3>{name(row.sessionId)}</h3><p>{t('parent')}: {row.parentSessionId === null ? t('session') : name(row.parentSessionId)}</p>
            {pageCalls.filter(call => call.sessionId === row.sessionId).map(call => <div className={css.call} key={call.callId} data-palette={palette(call.model)}
              title={`${time(call.startedAt)} — ${call.endedAt === null ? t('running') : time(call.endedAt)} · ${t('duration')}: ${minute(call.wallMs)}`}>
              <div className={css.rowLabel}><span>{t('model')}: {call.model}</span><span>{t('duration')}: {minute(call.wallMs)} · {t(call.endedAt === null ? 'running' : 'ended')}</span></div>
              {call.wallMs !== null && pageWallMax > 0 && <div className={css.track}><div className={css.bar} style={{ '--bar-width': `${call.wallMs / pageWallMax * 100}%` } as CSSProperties} /></div>}
              <small>{time(call.startedAt)} — {call.endedAt === null ? t('running') : time(call.endedAt)}</small>
            </div>)}
          </article>)}
          {sortedCalls.length === 0 && <p>{t('empty')}</p>}
          {pageCount > 1 && <div className={css.pager}>
            <Button variant="outline" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1) }}>{t('prevPage')}</Button>
            <span>{t('pageOf', { page: currentPage + 1, total: pageCount })}</span>
            <Button variant="outline" disabled={currentPage >= pageCount - 1} onClick={() => { setPage(currentPage + 1) }}>{t('nextPage')}</Button>
          </div>}
          {!family.some(row => row.sessionId !== root) && <p>{t('noChildren')}</p>}
        </>}
      </figure>
    </div>}
  </section>
}
