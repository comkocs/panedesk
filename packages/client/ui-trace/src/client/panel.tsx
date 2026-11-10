/** Right-sidebar project items: list, timeline, unassigned activity, close, and export. */
import { useState } from 'react'
import { Button, Input } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type {} from '@panedesk/dsh-client-resources/client'
import type {} from '@panedesk/dsh-client-ui-workspace/client'
import type { DecisionRevision, ItemId, ReferenceContent, TraceItem } from '@panedesk/dsh-trace-store/types'
import type { WorkspaceId } from '@panedesk/dsh-workspace/types'
import type { TraceOpenActions, TracePanelActions } from './index.ts'
import { decisionStatus, eventLine, itemMarkdown, itemStatus, sourceLine } from './format.ts'
import css from './panel.module.css'

type Props = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'trace'> & InjectFace<TracePanelActions>

/** Full props for the session-header items pill. */
export type TraceActionProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'trace'> & InjectFace<TraceOpenActions>

/** Session-header pill that opens this session's items page.
 * @param props Session standard props, localized copy, and the open action.
 * @returns One toolbar button, or null for the minimal preset.
 */
export function TraceAction({ sessionId, useSessions, t, open }: TraceActionProps) {
  const minimal = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset === 'minimal')
  if (minimal) return null
  return <Button variant="toolbar" size="sm" className={css.pill} onClick={() => { open(sessionId) }}>{t('title')}</Button>
}

/** Items and decisions for the workspace that owns this session.
 * @param props Framework session props and the trace actions.
 * @returns The items panel, or the off-state notice.
 */
export function TracePanel(props: Props) {
  const workspaces = props.useWorkspaces(value => value.items)
  const workspace = workspaces.find(item => item.sessionIds.includes(props.sessionId))
  const [page, setPage] = useState<'items' | 'decisions'>('items')
  const [revision, setRevision] = useState(0)
  const resource = props.useResource<'trace'>(workspace === undefined ? '' : `dsh-resource://trace/${encodeURIComponent(workspace.workspaceId)}?revision=${revision}`)
  const status = resource.value?.status ?? null
  const failed = resource.status === 'failed'
  if (workspace === undefined) return <section className={css.tab}><p>{props.t('off')}</p></section>
  return <section className={css.tab}>
    <h1 className={css.heading}>{props.t('title')}</h1>
    <p>{props.t('description')}</p>
    {failed && <p role="alert">{props.t('failed')}</p>}
    {status === null && !failed && <p role="status">{props.t('loading')}</p>}
    {status !== null && !status.enabled && <section>
      <p>{props.t('off')}</p>
      <Button variant="primary" onClick={() => { props.openSettings() }}>{props.t('openSettings')}</Button>
    </section>}
    {status?.enabled === true && <section>
      <div className={css.row}>
        <Button variant={page === 'items' ? 'primary' : 'outline'} onClick={() => { setPage('items') }}>{props.t('items')}</Button>
        <Button variant={page === 'decisions' ? 'primary' : 'outline'} onClick={() => { setPage('decisions') }}>{props.t('decisions')}</Button>
      </div>
      {page === 'items'
        ? <ItemsPage {...props} workspaceId={workspace.workspaceId} strict={status.strict} changed={() => { setRevision(value => value + 1) }} />
        : <DecisionsPage {...props} workspaceId={workspace.workspaceId} strict={status.strict} />}
    </section>}
  </section>
}

function ItemsPage({ sessionId, useResource, createItem, closeItem, assign, reference, t, workspaceId, changed }:
  Props & { workspaceId: WorkspaceId; strict: boolean; changed: () => void }) {
  const [tick, setTick] = useState(0)
  const [selected, setSelected] = useState<ItemId | null>(null)
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set())
  const [title, setTitle] = useState('')
  const [opened, setOpened] = useState<ReferenceContent | null>(null)
  const [failed, setFailed] = useState(false)
  const stamp = `${encodeURIComponent(workspaceId)}?revision=${tick}`
  const itemsResource = useResource<'traceitems'>(`dsh-resource://traceitems/${stamp}`)
  const looseResource = useResource<'tracetimeline'>(`dsh-resource://tracetimeline/${stamp}`)
  const itemResource = useResource<'tracetimeline'>(selected === null ? '' : `dsh-resource://tracetimeline/${stamp}&item=${selected}`)
  const items = itemsResource.value?.items
  const loose = looseResource.value?.page.events ?? []
  const events = itemResource.value?.page.events ?? []
  const refs = itemResource.value?.page.refs ?? []
  const open = items?.find(item => item.id === selected)
  const show = (itemId: ItemId): void => { setSelected(itemId) }
  const download = (name: string, text: string, type: string): void => {
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([text], { type }))
    link.download = name
    link.click()
    URL.revokeObjectURL(link.href)
  }
  const openItems = items?.filter(item => item.status === 'open') ?? []
  const closedItems = items?.filter(item => item.status !== 'open') ?? []
  return <section>
    {failed && <p role="alert">{t('failed')}</p>}
    <div className={css.row}>
      <label>{t('itemTitle')}<Input value={title} onChange={event => { setTitle(event.target.value) }} /></label>
      <Button variant="primary" disabled={title.trim() === ''} onClick={() => {
        void createItem(workspaceId, title.trim(), sessionId).then(item => {
          if (item === null) { setFailed(true); return }
          setTitle(''); setTick(value => value + 1); changed(); show(item.id)
        })
      }}>{t('create')}</Button>
    </div>
    <h2>{t('openItems')}</h2>
    <ItemList items={openItems} selected={selected} onSelect={show} t={t} />
    <h2>{t('closedItems')}</h2>
    <ItemList items={closedItems} selected={selected} onSelect={show} t={t} />
    {open === undefined && <p>{t('selectItem')}</p>}
    {open !== undefined && <section>
      <h2>{t('timeline')}</h2>
      <p>{sourceLine(open.source, t)}</p>
      {events.length === 0 && <p>{t('timelineEmpty')}</p>}
      <ul className={css.list}>{events.map(event => <li key={event.id} className={css.item}>
        <span>{eventLine(event, t)}</span>
        {refs.filter(row => row.eventId === event.id).map(row => <Button key={row.id} variant="ghost" onClick={() => {
          void reference(workspaceId, row.id).then(value => { setOpened(value); setFailed(value === null) })
        }}>{t('viewReference')}: {row.summary}</Button>)}
      </li>)}</ul>
      {opened !== null && <pre className={css.quote}>{opened.text === '' ? t('referenceEmpty') : opened.text}</pre>}
      <div className={css.row}>
        {open.status === 'open' && <Button variant="outline" onClick={() => {
          void closeItem(workspaceId, open.id).then(ok => { if (ok) { setTick(value => value + 1); changed() } else setFailed(true) })
        }}>{t('closeItem')}</Button>}
        <Button variant="outline" onClick={() => { download(`${open.title}.json`, JSON.stringify({ item: open, events, refs }, null, 2), 'application/json') }}>{t('exportJson')}</Button>
        <Button variant="outline" onClick={() => { download(`${open.title}.md`, itemMarkdown(open, events, refs, [], t), 'text/markdown') }}>{t('exportMd')}</Button>
      </div>
    </section>}
    <h2>{t('unassigned')}</h2>
    {loose.length === 0 && <p>{t('unassignedEmpty')}</p>}
    <ul className={css.list}>{loose.map(event => <li key={event.id}>
      <label><input type="checkbox" checked={checked.has(event.id)} onChange={input => {
        const next = new Set(checked)
        if (input.target.checked) next.add(event.id); else next.delete(event.id)
        setChecked(next)
      }} />{eventLine(event, t)}</label>
    </li>)}</ul>
    <Button variant="outline" disabled={checked.size === 0 || selected === null} onClick={() => {
      if (selected === null) return
      void assign(workspaceId, selected, [...checked]).then(ok => {
        if (!ok) { setFailed(true); return }
        setChecked(new Set()); setTick(value => value + 1); show(selected)
      })
    }}>{t('assign')}</Button>
  </section>
}

function ItemList({ items, selected, onSelect, t }: {
  items: readonly TraceItem[]
  selected: ItemId | null
  onSelect: (id: ItemId) => void
  t: Props['t']
}) {
  return <ul className={css.list}>{items.map(item => <li key={item.id}>
    <Button variant="ghost" className={item.id === selected ? css.selected : undefined} onClick={() => { onSelect(item.id) }}>
      {item.title} · {itemStatus(item.status, t)}
    </Button>
  </li>)}</ul>
}

function DecisionHistory({ useResource, t, workspaceId, tick, decisionId }:
  Pick<Props, 'useResource' | 't'> & { workspaceId: WorkspaceId; tick: number; decisionId: DecisionRevision['id'] }) {
  const rows = useResource<'tracehistory'>(`dsh-resource://tracehistory/${encodeURIComponent(workspaceId)}?decision=${encodeURIComponent(decisionId)}&revision=${tick}`).value?.rows ?? []
  const past = rows.filter(row => row.revision !== rows.at(-1)?.revision)
  if (past.length === 0) return <p>{t('historyEmpty')}</p>
  return <ul className={css.list}>{past.map(row => <li key={`${row.id}:${row.revision}`} className={css.item}>
    <span>{row.title} · {decisionStatus(row.status, t)} · v{row.revision}</span>
    <span className={css.muted}>{sourceLine(row.source, t)}</span>
  </li>)}</ul>
}

function DecisionsPage({ useResource, revert, confirm, reject, t, workspaceId, strict }:
  Props & { workspaceId: WorkspaceId; strict: boolean }) {
  const [tick, setTick] = useState(0)
  const [failed, setFailed] = useState(false)
  const rows = useResource<'tracedecisions'>(`dsh-resource://tracedecisions/${encodeURIComponent(workspaceId)}?revision=${tick}`).value?.rows
  const refresh = (ok: boolean): void => { if (ok) setTick(value => value + 1); else setFailed(true) }
  const ids = [...new Set((rows ?? []).map(row => row.id))]
  const revisionsOf = (id: string) => (rows ?? []).filter(row => row.id === id)
  const active = ids.flatMap(id => revisionsOf(id).filter(row => row.status === 'active' || row.status === 'reverted').slice(-1))
  const proposed = ids.flatMap(id => revisionsOf(id).slice(-1).filter(row => row.status === 'proposed'))
  return <section>
    {failed && <p role="alert">{t('failed')}</p>}
    <h2>{t('activeDecisions')}</h2>
    {active.length === 0 && <p>{t('decisionsEmpty')}</p>}
    <ul className={css.list}>{active.map(row => <li key={`${row.id}:${row.revision}`} className={css.item}>
      <strong>{row.title}</strong>
      <span>{sourceLine(row.source, t)} · {decisionStatus(row.status, t)} · v{row.revision}</span>
      <p>{row.body}</p>
      <Button variant="outline" onClick={() => { void revert(workspaceId, row.id).then(refresh) }}>{t('revert')}</Button>
    </li>)}</ul>
    {strict && <section>
      <h2>{t('proposed')}</h2>
      {proposed.length === 0 && <p>{t('proposedEmpty')}</p>}
      <ul className={css.list}>{proposed.map(row => <li key={`${row.id}:${row.revision}`} className={css.item}>
        <strong>{row.title}</strong>
        <span>{sourceLine(row.source, t)}</span>
        <p>{row.body}</p>
        <div className={css.row}>
          <Button variant="primary" onClick={() => { void confirm(workspaceId, row.id, row.revision).then(refresh) }}>{t('confirm')}</Button>
          <Button variant="outline" onClick={() => { void reject(workspaceId, row.id, row.revision).then(refresh) }}>{t('reject')}</Button>
        </div>
      </li>)}</ul>
    </section>}
    <h2>{t('history')}</h2>
    {ids.map(id => <DecisionHistory key={id} {...{ useResource, t, workspaceId, tick, decisionId: id }} />)}
  </section>
}
