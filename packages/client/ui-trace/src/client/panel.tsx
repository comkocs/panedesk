/** Right-sidebar project items: list, timeline, unassigned activity, close, and export. */
import { useState } from 'react'
import { Button, Input } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type {} from '@panedesk/dsh-client-resources/client'
import type {} from '@panedesk/dsh-client-ui-workspace/client'
import type { DecisionRevision, ItemId, ReferenceContent, ReferenceId, TraceItem } from '@panedesk/dsh-trace-store/types'
import type { WorkspaceId } from '@panedesk/dsh-workspace/types'
import type { RemoteResult } from '@panedesk/dsh-typert-protocol'
import type { TraceOpenActions, TracePanelActions } from './index.ts'
import { decisionStatus, eventLine, eventType, itemMarkdown, itemStatus, referenceText, sourceLine } from './format.ts'
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
  const [notice, setNotice] = useState<string | null>(null)
  const resource = props.useResource<'trace'>(workspace === undefined ? '' : `dsh-resource://trace/${encodeURIComponent(workspace.workspaceId)}`)
  const status = resource.value?.status ?? null
  const failed = resource.status === 'failed'
  if (workspace === undefined) return <section className={css.tab}><p>{props.t('off')}</p></section>
  return <section className={css.tab} onClickCapture={() => { setNotice(null) }} onChangeCapture={() => { setNotice(null) }}>
    <h1 className={css.heading}>{props.t('title')}</h1>
    <p>{props.t('description')}</p>
    {failed && <p role="alert">{props.t('failed', { reason: resource.failure!.message })}</p>}
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
        ? <ItemsPage {...props} workspaceId={workspace.workspaceId} notice={notice} setNotice={setNotice} />
        : <DecisionsPage {...props} workspaceId={workspace.workspaceId} strict={status.strict} />}
    </section>}
  </section>
}

function ItemsPage({ sessionId, useResource, createItem, closeItem, assign, reference, exportText, t, workspaceId, notice, setNotice }:
  Props & { workspaceId: WorkspaceId; notice: string | null; setNotice: (notice: string | null) => void }) {
  const [tick, setTick] = useState(0)
  const [selected, setSelected] = useState<ItemId | null>(null)
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set())
  const [title, setTitle] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const stamp = `${encodeURIComponent(workspaceId)}?revision=${tick}`
  const itemsResource = useResource<'traceitems'>(`dsh-resource://traceitems/${stamp}`)
  const looseResource = useResource<'tracetimeline'>(`dsh-resource://tracetimeline/${stamp}`)
  const itemResource = useResource<'tracetimeline'>(selected === null ? '' : `dsh-resource://tracetimeline/${stamp}&item=${selected}`)
  const readFailure = itemsResource.failure ?? looseResource.failure ?? itemResource.failure
  const items = itemsResource.value?.items
  const loose = looseResource.value?.page.events ?? []
  const events = itemResource.value?.page.events ?? []
  const refs = itemResource.value?.page.refs ?? []
  const open = items?.find(item => item.id === selected)
  const show = (itemId: ItemId): void => { setSelected(itemId) }
  const download = (name: string, text: string, type: string): void => {
    const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, '_')
    setNotice(t('exporting', { name: safe }))
    setFailure(null)
    void exportText(safe, text, type).then(saved => {
      if (saved !== undefined) setNotice(saved === null ? t('exportCancelled') : t('exported', { name: saved }))
    }).catch((error: unknown) => {
      setNotice(null)
      setFailure(error instanceof Error ? error.message : String(error))
    })
  }
  const openItems = items?.filter(item => item.status === 'open') ?? []
  const closedItems = items?.filter(item => item.status !== 'open') ?? []
  return <section>
    {failure !== null && <p role="alert">{t('actionFailed', { reason: failure })}</p>}
    {readFailure && <p role="alert">{t('failed', { reason: readFailure.message })}</p>}
    <div className={css.row}>
      <label>{t('itemTitle')}<Input value={title} onChange={event => { setTitle(event.target.value) }} /></label>
      <Button variant="primary" disabled={title.trim() === ''} onClick={() => {
        void createItem(workspaceId, title.trim(), sessionId).then(result => {
          if (!result.ok) { setFailure(result.error.message); return }
          setFailure(null); setTitle(''); setTick(value => value + 1); show(result.value.id)
        }).catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) })
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
      <ul className={css.list}>{events.map(event => <li key={event.id} className={css.item} title={eventType(event)}>
        <span className={css.activity}>{eventLine(event, t)}</span>
        {refs.filter(row => row.eventId === event.id).map(row => <ReferenceRow key={row.id} referenceId={row.id}
          workspaceId={workspaceId} reference={reference} t={t} setFailure={setFailure} />)}
      </li>)}</ul>
      <div className={css.row}>
        {open.status === 'open' && <Button variant="outline" onClick={() => {
          void closeItem(workspaceId, open.id).then(result => {
            if (!result.ok) { setFailure(result.error.message); return }
            setFailure(null); setTick(value => value + 1)
          }).catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) })
        }}>{t('closeItem')}</Button>}
        <Button variant="outline" onClick={() => { download(`${open.title}.json`, JSON.stringify({ item: open, events, refs }, null, 2), 'application/json') }}>{t('exportJson')}</Button>
        <Button variant="outline" onClick={() => { download(`${open.title}.md`, itemMarkdown(open, events, refs, [], t), 'text/markdown') }}>{t('exportMd')}</Button>
      </div>
      {notice !== null && <p role="status">{notice}</p>}
    </section>}
    <h2>{t('unassigned')}</h2>
    {loose.length === 0 && <p>{t('unassignedEmpty')}</p>}
    <ul className={css.loose}>{loose.map(event => <li key={event.id} title={eventType(event)}>
      <label><input type="checkbox" checked={checked.has(event.id)} onChange={input => {
        const next = new Set(checked)
        if (input.target.checked) next.add(event.id); else next.delete(event.id)
        setChecked(next)
      }} />{eventLine(event, t)}</label>
    </li>)}</ul>
    <p>{t('assignTarget')}: {open?.status === 'open' ? open.title : t('chooseItem')}</p>
    <Button variant="outline" disabled={checked.size === 0 || open?.status !== 'open'} onClick={() => {
      if (selected === null) return
      void assign(workspaceId, selected, [...checked]).then(result => {
        if (!result.ok) { setFailure(result.error.message); return }
        setFailure(null); setChecked(new Set()); setTick(value => value + 1); show(selected)
      }).catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) })
    }}>{t('assign')}</Button>
  </section>
}

function ReferenceRow({ referenceId, workspaceId, reference, t, setFailure }: Pick<Props, 'reference' | 't'> & {
  referenceId: ReferenceId; workspaceId: WorkspaceId; setFailure: (failure: string | null) => void
}) {
  const [opened, setOpened] = useState<ReferenceContent | null>(null)
  return <>
    <Button variant="ghost" size="sm" className={css.reference} aria-expanded={opened !== null} onClick={() => {
      if (opened !== null) { setOpened(null); return }
      void reference(workspaceId, referenceId).then(result => {
        if (!result.ok) { setFailure(result.error.message); return }
        setOpened({ ...result.value, text: referenceText(result.value) }); setFailure(null)
      }).catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) })
    }}>{t(opened === null ? 'viewReference' : 'hideReference')}</Button>
    {opened !== null && <pre className={css.quote}>{opened.text === '' ? t('referenceEmpty') : opened.text}</pre>}
  </>
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

function DecisionsPage({ useResource, revert, confirm, reject, t, workspaceId, strict }:
  Props & { workspaceId: WorkspaceId; strict: boolean }) {
  const [tick, setTick] = useState(0)
  const [failure, setFailure] = useState<string | null>(null)
  const resource = useResource<'tracedecisions'>(`dsh-resource://tracedecisions/${encodeURIComponent(workspaceId)}?revision=${tick}`)
  const rows = resource.value?.rows
  const refresh = (result: RemoteResult<DecisionRevision>): void => {
    if (!result.ok) { setFailure(result.error.message); return }
    setFailure(null); setTick(value => value + 1)
  }
  const ids = [...new Set((rows ?? []).map(row => row.id))]
  const revisionsOf = (id: string) => (rows ?? []).filter(row => row.id === id)
  const active = ids.flatMap(id => revisionsOf(id).filter(row => row.status === 'active' || row.status === 'reverted').slice(-1))
  const proposed = ids.flatMap(id => revisionsOf(id).slice(-1).filter(row => row.status === 'proposed'))
  const past = ids.flatMap(id => revisionsOf(id).filter(row => row.status === 'rejected' || row.revision !== revisionsOf(id).at(-1)?.revision))
  const decisionSource = (row: DecisionRevision) => sourceLine(
    row.source.actor === 'user' ? { ...(revisionsOf(row.id).findLast(revision => revision.revision < row.revision
      && revision.title === row.title && revision.body === row.body && revision.source.actor !== 'user')?.source ?? row.source), time: row.source.time } : row.source, t,
  )
  return <section>
    {failure !== null && <p role="alert">{t('actionFailed', { reason: failure })}</p>}
    {resource.status === 'failed' && <p role="alert">{t('failed', { reason: resource.failure!.message })}</p>}
    <h2>{t('activeDecisions')}</h2>
    {active.length === 0 && <p>{t('decisionsEmpty')}</p>}
    <ul className={css.list}>{active.map(row => <li key={`${row.id}:${row.revision}`} className={css.item}>
      <strong>{row.title}</strong>
      <span>{decisionSource(row)} · {decisionStatus(row.status, t)} · v{row.revision}</span>
      <p>{row.body}</p>
      {row.status !== 'reverted' && <Button variant="outline" onClick={() => { void revert(workspaceId, row.id).then(refresh).catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) }) }}>{t('revert')}</Button>}
    </li>)}</ul>
    {strict && <section>
      <h2>{t('proposed')}</h2>
      {proposed.length === 0 && <p>{t('proposedEmpty')}</p>}
      <ul className={css.list}>{proposed.map(row => <li key={`${row.id}:${row.revision}`} className={css.item}>
        <strong>{row.title}</strong>
        <span>{decisionSource(row)}</span>
        <p>{row.body}</p>
        <div className={css.row}>
          <Button variant="primary" onClick={() => { void confirm(workspaceId, row.id, row.revision).then(refresh).catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) }) }}>{t('confirm')}</Button>
          <Button variant="outline" onClick={() => { void reject(workspaceId, row.id, row.revision).then(refresh).catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) }) }}>{t('reject')}</Button>
        </div>
      </li>)}</ul>
    </section>}
    <h2>{t('history')}</h2>
    {past.length === 0 && <p>{t('historyEmpty')}</p>}
    <ul className={css.list}>{past.map(row => <li key={`${row.id}:${row.revision}`} className={css.item}>
      <span>{row.title} · {decisionStatus(row.status === 'proposed' && revisionsOf(row.id).find(next => next.revision === row.revision + 1)?.status === 'rejected' ? 'rejected' : row.status, t)} · v{row.revision}</span>
      <span className={css.muted}>{decisionSource(row)}</span>
    </li>)}</ul>
  </section>
}
