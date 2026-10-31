/** Five-tab statistics presentation; business data is read only through framework resources. */
import { useState } from 'react'
import { IconPanedeskStats } from '@panedesk/dsh-client-ui-panedesk-icons'
import { Button, Checkbox, Menu } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { StatsAggregate, StatsDetailCursor, StatsRequest } from '@panedesk/dsh-ledger-query/types'
import type { StatsActions, StatsData } from './index.ts'
import type { StatsKey } from './locales.ts'
import css from './panel.module.css'

type MainProps = PropsRuntime<'main'> & PropsLocale<'stats'>
type SettingsProps = PropsRuntime<'settings.section'> & PropsLocale<'stats'> & InjectFace<StatsActions>
type ToolsProps = PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<'stats'> & InjectFace<StatsActions>
type Tab = 'overview' | 'history' | 'models' | 'throughput' | 'ledger'
const tabIds: readonly Tab[] = ['overview', 'history', 'models', 'throughput', 'ledger']
const ranges = ['today', '6h', '24h', '72h', '168h', 'all'] as const
const dimensions = ['seat', 'taskId', 'model', 'window', 'role', 'definition'] as const

function stateKey(status: string, value: StatsData | undefined, code: string | undefined): StatsKey {
  if (code === 'stats/unauthorized') return 'unauthorized'
  if (code === 'stats/disabled') return 'disabled'
  if (status === 'failed') return value ? 'failed' : 'error'
  if (status === 'loading') return 'loading'
  if (!value) return 'idle'
  if (!value.view.complete) return 'partial'
  return value.view.summary.calls === 0 ? 'empty' : 'success'
}

/** Settings summary stays secondary and opens the same main-area panel.
 * @param props - Framework resource read, localized copy, close and navigation actions.
 * @returns Read-only summary and the main-area launch control.
 */
export function StatsSettings({ useResource, t, open, close }: SettingsProps) {
  const resource = useResource<'stats'>('dsh-resource://stats/view?range=today&paused=true')
  const view = resource.value?.view
  return <section className={css.settings}>
    <h2>{t('title')}</h2><p>{t('description')}</p><p>{t('reference')}</p>
    <p role={resource.status === 'failed' ? 'alert' : 'status'}>{t(stateKey(resource.status, resource.value, resource.failure?.code))}</p>
    {view && <p>{t('calls')}: {view.summary.calls} · {t('costUsd')}: {view.summary.costUsd ?? t('unknown')} · {t('runningLanes')}: {view.runningLanes.count ?? t('unknown')}</p>}
    <Button onClick={() => { close(); open() }}>{t('open')}</Button>
  </section>
}

/** The session-only tools menu never contributes to the initial sidebar or hero.
 * @param props - Localized labels and main-area navigation.
 * @returns Accessible shared menu with one statistics action.
 */
export function StatsTools({ t, open }: ToolsProps) {
  const [expanded, setExpanded] = useState(false)
  return <Menu open={expanded} onClose={() => { setExpanded(false) }} align="end" autoFocus
    anchor={<Button variant="toolbar" onClick={() => { setExpanded(value => !value) }} aria-expanded={expanded} aria-haspopup="menu">{t('tools')}</Button>}
    items={[{ id: 'stats', label: t('title') }]} onSelect={() => { setExpanded(false); open() }} />
}

/** Render all tab values from one selection and snapshot; missing evidence is never zero-filled.
 * @param props - Framework resource hook and typed locale seat.
 * @returns Controls, six overview cards, five tab panels and the query-time footer.
 */
export function StatsPanel({ useResource, t }: MainProps) {
  const [tab, setTab] = useState<Tab>('overview')
  const [request, setRequest] = useState<StatsRequest>({ range: 'today', bucket: 'hour', groupBy: 'seat' })
  const [paused, setPaused] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [wide, setWide] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [menu, setMenu] = useState<'range' | 'groupBy' | 'bucket' | 'model' | null>(null)
  const selectionKey = JSON.stringify([request, refresh])
  const [paging, setPaging] = useState<{ selection: string; cursors: StatsDetailCursor[] }>({ selection: selectionKey, cursors: [] })
  const cursors = paging.selection === selectionKey ? paging.cursors : []
  const after = cursors.at(-1)
  const params = new URLSearchParams({ range: request.range, bucket: request.bucket, groupBy: request.groupBy,
    paused: String(paused || after !== undefined), refresh: String(refresh), detailsLimit: '100',
    ...(after === undefined ? {} : { after: JSON.stringify(after) }), ...(request.seat === undefined ? {} : { seat: request.seat }),
    ...(request.model === undefined ? {} : { model: request.model }) })
  const resource = useResource<'stats'>(`dsh-resource://stats/view?${params}`)
  const view = resource.value?.view
  const message = stateKey(resource.status, resource.value, resource.failure?.code)
  const number = (value: number | string | null | undefined): string => value === null || value === undefined ? t('unknown') : String(value)
  const time = (value: number | null): string => value === null ? t('unknown')
    : new Intl.DateTimeFormat(undefined, { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(value)
  const groupName = (key: string): string => key === '' ? t('unknown') : request.groupBy === 'role' && (key === 'root' || key === 'child') ? t(key) : key
  const renderTable = (caption: StatsKey, headers: readonly StatsKey[],
    rows: readonly { id: string; cells: readonly (string | number)[] }[]) => <div className={css.tableWrap}>
    <table><caption>{t(caption)}</caption><thead><tr>{headers.map(header => <th scope="col" key={header}>{t(header)}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        {row.cells.map((cell, column) => <td key={headers[column]}>{cell}</td>)}</tr>)}</tbody></table>
    {rows.length === 0 && <p>{t(caption === 'runningLanes' ? 'emptyRunning' : 'empty')}</p>}
  </div>
  const aggregateRows = (rows: readonly StatsAggregate[]) => rows.map(row => ({ id: row.key, cells: [groupName(row.key), row.calls,
    number(row.usage.inputTokens), number(row.usage.cacheReadTokens), number(row.usage.cacheWriteTokens),
    number(row.usage.cacheWriteShortTokens), number(row.usage.cacheWriteLongTokens),
    number(row.usage.outputTokens), number(row.costUsd), number(row.modelInFlightMs), number(row.outputTokensPerSecond),
    t('observed', { known: row.usage.completeUsageCalls, total: row.calls })] }))
  const aggregateHeaders: readonly StatsKey[] = ['model', 'calls', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWriteShortTokens', 'cacheWriteLongTokens', 'outputTokens', 'costUsd', 'duration', 'speed', 'coverage']
  const choose = (id: string) => {
    if (menu === 'model') setRequest(({ model: _model, ...rest }) => id === '' ? rest : { ...rest, model: id })
    if (menu === 'range') { const range = ranges.find(value => value === id); if (range) setRequest(value => ({ ...value, range })) }
    if (menu === 'groupBy') { const groupBy = dimensions.find(value => value === id); if (groupBy) setRequest(value => ({ ...value, groupBy })) }
    if (menu === 'bucket' && (id === 'hour' || id === 'day')) setRequest(value => ({ ...value, bucket: id }))
    setMenu(null)
  }
  return <section className={`${css.panel} ${wide ? css.wide : ''}`} data-reduced-motion={reducedMotion}>
    <header><h1><IconPanedeskStats />{t('title')}</h1><nav aria-label={t('title')} className={css.tabs}>{tabIds.map(value =>
      <Button key={value} variant={tab === value ? 'primary' : 'ghost'} aria-pressed={tab === value} onClick={() => { setTab(value) }}>{t(value)}</Button>)}</nav>
    <div className={css.controls}>
      <Checkbox checked={reducedMotion} onChange={setReducedMotion} label={t('motion')} />
      {(['range', 'groupBy', 'bucket'] as const).map(kind => <Menu key={kind} open={menu === kind} onClose={() => { setMenu(null) }} autoFocus
        anchor={<Button variant="outline" aria-haspopup="menu" aria-expanded={menu === kind} onClick={() => { setMenu(menu === kind ? null : kind) }}>{t(kind)}: {t(request[kind])}</Button>}
        items={(kind === 'range' ? ranges : kind === 'groupBy' ? dimensions : ['hour', 'day'] as const).map(id => ({ id, label: t(id) }))}
        selectedId={request[kind]} onSelect={choose} />)}
      {(tab === 'models' || tab === 'throughput') && <Menu open={menu === 'model'} onClose={() => { setMenu(null) }} autoFocus
        anchor={<Button variant="outline" aria-haspopup="menu" aria-expanded={menu === 'model'} onClick={() => { setMenu(menu === 'model' ? null : 'model') }}>{t('model')}: {request.model ?? t('all')}</Button>}
        items={[{ id: '', label: t('all') }, ...[...new Set([...(view?.models.map(row => row.key) ?? []), ...(request.model ? [request.model] : [])])].map(model => ({ id: model, label: model }))]}
        selectedId={request.model ?? ''} onSelect={choose} />}
      <Button variant="outline" aria-pressed={wide} onClick={() => { setWide(value => !value) }}>{t('layout')}: {t(wide ? 'wide' : 'standard')}</Button>
      <Button variant="outline" aria-pressed={paused} onClick={() => { setPaused(value => !value) }}>{t(paused ? 'resume' : 'pause')}</Button>
      <Button disabled={resource.status === 'loading'} onClick={() => { setRefresh(value => value + 1) }}>{t('refresh')}</Button>
    </div>
    </header>
    <p>{t('reference')}</p><p>{t('cacheNote')}</p><p>{t('modelNote')}</p>
    <p role={resource.status === 'failed' ? 'alert' : 'status'} aria-live="polite">{t(message)}</p>
    {paused && <p>{t('paused')}</p>}
    {request.seat !== undefined && <p>{t('selectedProject', { seat: request.seat })} <Button variant="ghost" onClick={() => { setRequest(({ seat: _seat, ...rest }) => rest) }}>{t('clear')}</Button></p>}
    {request.model !== undefined && <p>{t('model')}: {request.model}
      <Button variant="ghost" onClick={() => { setRequest(({ model: _model, ...rest }) => rest) }}>{t('clear')}</Button></p>}
    {view && <div aria-label={t(tab)} aria-busy={resource.status === 'loading'}>
      {tab === 'overview' && <>
        <div className={css.cards}>{([
          ['runningWindows', view.runningWindows], ['costUsd', view.summary.costUsd],
          ['tokens', view.summary.usage.completeUsageCalls === view.summary.calls ? view.summary.usage.knownTokens : null],
          ['alerts', view.alerts], ['cache', view.cacheHitRate.value === undefined ? null : `${(view.cacheHitRate.value * 100).toFixed(1)}%`],
          ['runningLanes', view.runningLanes.count],
        ] as const).map(([label, value]) => <article key={label}><h2>{t(label)}</h2><strong>{number(value)}</strong></article>)}</div>
        <p>{t('keepaliveSummary', { calls: view.keepalive.calls, usd: view.keepalive.costUsd ?? t('unknown') })}</p>
        <p>{t('unknownLanes', { count: view.runningLanes.unknownSessions })}</p>
        {renderTable('runningLanes', ['seat', 'runningLanes'], view.runningLanes.bySeat.map(row => ({ id: row.seat, cells: [row.seat, row.count] })))}
        <p>{t('projectNote')}</p>
        <h2>{t('projects')}</h2><div className={css.cards}>{view.projects.map(project => <article key={project.key}>
          <Button variant="ghost" onClick={() => { setRequest(value => ({ ...value, seat: project.key })) }}>{project.key || t('unknown')}</Button>
          <p>{t('calls')}: {project.calls} · {t('costUsd')}: {number(project.costUsd)}</p></article>)}</div>
        {renderTable('windows', ['window', 'seat', 'taskId', 'sessionId', 'parent', 'status', 'calls', 'tokens', 'costUsd'], view.windows.map(row => ({ id: row.sessionId,
          cells: [row.window, row.seat, row.taskIds.length ? row.taskIds.join(', ') : t('unknown'), row.sessionId, row.parentSessionId ?? t('unknown'),
            row.running === null ? t('unknown') : t(row.running ? 'running' : 'ended'), row.calls,
            row.usage.completeUsageCalls === row.calls ? row.usage.knownTokens : t('unknown'), number(row.costUsd)] })))}
      </>}
      {tab === 'history' && <>
        {renderTable('groups', [request.groupBy, ...aggregateHeaders.slice(1)], aggregateRows(view.groups))}
        <figure className={css.trend} aria-label={t('trend')}><figcaption>{t('trend')}</figcaption>{view.buckets.map(row =>
          <div key={row.key}><span>{time(row.startedAt)} · {row.model}</span>
            <meter min={0} max={Math.max(1, ...view.buckets.map(bucket => bucket.usage.knownTokens))}
              value={row.usage.knownTokens} aria-label={`${time(row.startedAt)} · ${row.model} · ${t('tokens')}`} />
            <span>{row.usage.knownTokens} · {t('observed', { known: row.usage.completeUsageCalls, total: row.calls })}</span></div>)}</figure>
        {renderTable('trend', ['startedAt', 'model', 'calls', 'tokens', 'costUsd'], view.buckets.map(row => ({ id: row.key,
          cells: [time(row.startedAt), row.model, row.calls, row.usage.completeUsageCalls === row.calls ? row.usage.knownTokens : t('unknown'), number(row.costUsd)] })))}
      </>}
      {tab === 'models' && renderTable('models', aggregateHeaders, aggregateRows(view.models))}
      {tab === 'throughput' && <><p>{t('speedNote')}</p>{renderTable('throughput', aggregateHeaders, aggregateRows(view.models))}</>}
      {tab === 'ledger' && renderTable('ledger', ['callId', 'model', 'response', 'seat', 'window', 'taskId', 'sessionId', 'parent', 'purpose', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWriteShortTokens', 'cacheWriteLongTokens', 'tiering', 'outputTokens', 'usageState', 'costUsd', 'priceVersion', 'startedAt', 'endedAt', 'wallMs', 'duration', 'waits', 'peak', 'compactions', 'compactionTimes', 'endReason', 'prefix', 'speed'],
        view.details.map(row => ({ id: row.callId, cells: [row.callId, row.model, row.responseModelReported ?? t('unknown'), row.seat, row.window,
          row.taskId ?? t('unknown'), row.sessionId, row.parentSessionId ?? t('unknown'), row.purpose,
          number(row.tokens.inputTokens), number(row.tokens.cacheReadTokens), number(row.tokens.cacheWriteTokens),
          number(row.tokens.cacheWriteShortTokens), number(row.tokens.cacheWriteLongTokens),
          row.tokens.cacheWriteTiering.kind === 'tiered' ? t('cacheTiers', row.tokens.cacheWriteTiering) : t('unavailableTier'),
          number(row.tokens.outputTokens), row.usageState, number(row.costUsd), row.priceVersion ?? t('unknown'), time(row.startedAt), time(row.endedAt),
          number(row.wallMs), number(row.modelInFlightMs), row.waits === null ? t('unknown') : JSON.stringify(row.waits), number(row.peakContextTokens),
          number(row.compactionCount), row.compactionTimes === null ? t('unknown') : row.compactionTimes.map(time).join(', '), row.endReason ?? t('unknown'),
          row.prefixFingerprint ?? t('unknown'), number(row.outputTokensPerSecond)] })))}
      {tab === 'ledger' && <nav aria-label={t('pagination')}>
        <Button disabled={cursors.length === 0 || resource.status === 'loading'} onClick={() => {
          setPaging({ selection: selectionKey, cursors: cursors.slice(0, -1) })
        }}>{t('previousPage')}</Button>
        <span>{t('page', { page: cursors.length + 1 })}</span>
        <Button disabled={!view.nextDetailCursor || resource.status !== 'live'} onClick={() => {
          if (view.nextDetailCursor) setPaging({ selection: selectionKey, cursors: [...cursors, view.nextDetailCursor] })
        }}>{t('nextPage')}</Button>
        <p>{t('pageNote')}</p>
      </nav>}
      <footer>{t('queryMs', { ms: view.queryMs.toFixed(2), time: time(view.asOf) })}</footer>
    </div>}
  </section>
}
