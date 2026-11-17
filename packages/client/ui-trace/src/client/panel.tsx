/** Right-sidebar project items: list, timeline, unassigned activity, close, and export. */
import { useId, useState } from 'react'
import { Button, Checkbox, Input, SegmentedTabs } from '@panedesk/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type {} from '@panedesk/dsh-client-resources/client'
import type {} from '@panedesk/dsh-client-ui-workspace/client'
import type { DecisionRevision, ItemId, ReferenceContent, ReferenceId, TraceEvent, TraceItem } from '@panedesk/dsh-trace-store/types'
import type { WorkspaceId } from '@panedesk/dsh-workspace/types'
import type { RemoteResult } from '@panedesk/dsh-typert-protocol'
import type { TraceOpenActions, TracePanelActions } from './index.ts'
import { decisionStatus, eventLine, eventParts, itemMarkdown, referenceText, sourceLine } from './format.ts'
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
  const pageId = useId()
  const [notice, setNotice] = useState<string | null>(null)
  // Kept here so switching to Decisions and back keeps the selected item open.
  const [selected, setSelected] = useState<ItemId | null>(null)
  const resource = props.useResource<'trace'>(workspace === undefined ? '' : `dsh-resource://trace/${encodeURIComponent(workspace.workspaceId)}`)
  const status = resource.value?.status ?? null
  const failed = resource.status === 'failed'
  if (workspace === undefined) return <section className={css.tab}><p>{props.t('off')}</p></section>
  return <section className={css.tab} onClickCapture={() => { setNotice(null) }} onChangeCapture={() => { setNotice(null) }}>
    <header className={css.header}>
      <h1 className={css.heading}>{props.t('title')}</h1>
      <p className={css.muted}>{props.t('description')}</p>
    </header>
    {failed && <p role="alert">{props.t('failed', { reason: resource.failure!.message })}</p>}
    {status === null && !failed && <p role="status">{props.t('loading')}</p>}
    {status !== null && !status.enabled && <section>
      <p>{props.t('off')}</p>
      <Button variant="primary" size="sm" onClick={() => { props.openSettings() }}>{props.t('openSettings')}</Button>
    </section>}
    {status?.enabled === true && <section className={css.section}>
      <SegmentedTabs className={css.tabs} value={page} onChange={setPage} label={props.t('title')} items={[
        { value: 'items', label: props.t('items'), id: `${pageId}-items`, panelId: `${pageId}-items-panel` },
        { value: 'decisions', label: props.t('decisions'), id: `${pageId}-decisions`, panelId: `${pageId}-decisions-panel` },
      ]} />
      <div role="tabpanel" id={`${pageId}-${page}-panel`} aria-labelledby={`${pageId}-${page}`}>
        {page === 'items'
          ? <ItemsPage {...props} workspaceId={workspace.workspaceId} notice={notice} setNotice={setNotice}
            selected={selected} setSelected={setSelected} />
          : <DecisionsPage {...props} workspaceId={workspace.workspaceId} strict={status.strict} />}
      </div>
    </section>}
  </section>
}

function ItemsPage({ sessionId, useResource, createItem, closeItem, assign, reference, exportText, t, workspaceId, notice, setNotice, selected, setSelected }:
  Props & { workspaceId: WorkspaceId; notice: string | null; setNotice: (notice: string | null) => void
    selected: ItemId | null; setSelected: (selected: ItemId | null) => void }) {
  const [tick, setTick] = useState(0)
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set())
  const [title, setTitle] = useState('')
  const [closedExpanded, setClosedExpanded] = useState(false)
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
  return <section className={css.section}>
    {failure !== null && <p role="alert">{t('actionFailed', { reason: failure })}</p>}
    {readFailure && <p role="alert">{t('failed', { reason: readFailure.message })}</p>}
    <form className={css.create} onSubmit={event => {
      event.preventDefault()
      if (title.trim() === '') return
      void createItem(workspaceId, title.trim(), sessionId).then(result => {
        if (!result.ok) { setFailure(result.error.message); return }
        setFailure(null); setTitle(''); setTick(value => value + 1); show(result.value.id)
      }).catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) })
    }}>
      <Input className={css.titleInput!} aria-label={t('itemTitle')} placeholder={t('newItemTitle')}
        value={title} onChange={event => { setTitle(event.target.value) }} />
      <Button variant="primary" size="sm" type="submit" disabled={title.trim() === ''}>{t('create')}</Button>
    </form>
    <h2 className={css.heading}>{t('openItems')} <span className={css.count}>{openItems.length}</span></h2>
    <ItemList items={openItems} selected={selected} onSelect={show} />
    <h2 className={css.heading}>
      <Button variant="ghost" size="sm" className={css.fold} aria-expanded={closedExpanded}
        onClick={() => { setClosedExpanded(value => !value) }}>
        <span aria-hidden="true">{closedExpanded ? '▾' : '▸'}</span>
        {t('closedItems')} <span className={css.count}>{closedItems.length}</span>
      </Button>
    </h2>
    {closedExpanded && <ItemList items={closedItems} selected={selected} onSelect={show} />}
    {open === undefined && <p>{t('selectItem')}</p>}
    {open !== undefined && <section className={css.section}>
      <h2 className={css.heading}>{t('timeline')} · <span className={css.truncate}>{open.title}</span></h2>
      <p className={css.muted}>{sourceLine(open.source, t)}</p>
      {/* Pinned to the panel scrollport so close and export stay reachable as the timeline grows. */}
      <div className={css.actions}>
        <div className={css.row}>
          {open.status === 'open' && <Button variant="outline" size="sm" onClick={() => {
            void closeItem(workspaceId, open.id).then(result => {
              if (!result.ok) { setFailure(result.error.message); return }
              setFailure(null); setTick(value => value + 1)
            }).catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) })
          }}>{t('closeItem')}</Button>}
          <Button variant="outline" size="sm" onClick={() => { download(`${open.title}.json`, JSON.stringify({ item: open, events, refs }, null, 2), 'application/json') }}>{t('exportJson')}</Button>
          <Button variant="outline" size="sm" onClick={() => { download(`${open.title}.md`, itemMarkdown(open, events, refs, [], t), 'text/markdown') }}>{t('exportMd')}</Button>
        </div>
        {notice !== null && <p className={css.notice} role="status">{notice}</p>}
      </div>
      {events.length === 0 && <p>{t('timelineEmpty')}</p>}
      <ul className={css.list}>{events.map(event => <li key={event.id} className={css.item}>
        <ActivityText event={event} t={t} />
        {refs.filter(row => row.eventId === event.id).map(row => <ReferenceRow key={row.id} referenceId={row.id}
          workspaceId={workspaceId} reference={reference} t={t} setFailure={setFailure} />)}
      </li>)}</ul>
    </section>}
    <h2 className={css.heading}>{t('unassigned')} <span className={css.count}>{loose.length}</span></h2>
    {loose.length === 0 && <p>{t('unassignedEmpty')}</p>}
    <ul className={css.loose}>{loose.map(event => <li key={event.id} className={css.looseRow}>
      <Checkbox className={css.checkbox} label={eventLine(event, t)} checked={checked.has(event.id)} onChange={value => {
        const next = new Set(checked)
        if (value) next.add(event.id); else next.delete(event.id)
        setChecked(next)
      }} />
      <span className={css.looseText} aria-hidden="true"><ActivityText event={event} t={t} /></span>
    </li>)}</ul>
    <div className={css.assign}>
      <p className={css.truncate}>{t('assignTarget')}: {open?.status === 'open' ? open.title : t('chooseItem')}</p>
      <Button variant="outline" size="sm" disabled={checked.size === 0 || open?.status !== 'open'} onClick={() => {
        if (selected === null) return
        void assign(workspaceId, selected, [...checked]).then(result => {
          if (!result.ok) { setFailure(result.error.message); return }
          setFailure(null); setChecked(new Set()); setTick(value => value + 1); show(selected)
        }).catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) })
      }}>{t('assign')}</Button>
    </div>
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

function ActivityText({ event, t }: { event: TraceEvent; t: Props['t'] }) {
  const { who, action } = eventParts(event, t)
  return <span className={css.activity}><span className={css.prefix}>{who}</span> {action}</span>
}

function ItemList({ items, selected, onSelect }: {
  items: readonly TraceItem[]
  selected: ItemId | null
  onSelect: (id: ItemId) => void
}) {
  return <ul className={css.list}>{items.map(item => <li key={item.id}>
    <Button variant="ghost" size="sm" className={css.itemButton} aria-pressed={item.id === selected}
      onClick={() => { onSelect(item.id) }}>
      <span className={css.truncate}>{item.title}</span>
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
  return <section className={css.section}>
    {failure !== null && <p role="alert">{t('actionFailed', { reason: failure })}</p>}
    {resource.status === 'failed' && <p role="alert">{t('failed', { reason: resource.failure!.message })}</p>}
    <h2 className={css.heading}>{t('activeDecisions')} <span className={css.count}>{active.length}</span></h2>
    {active.length === 0 && <p>{t('decisionsEmpty')}</p>}
    <ul className={css.list}>{active.map(row => <li key={`${row.id}:${row.revision}`} className={css.card}>
      <h3 className={css.heading}>{row.title}</h3>
      <span className={css.metadata}>{decisionSource(row)} · {decisionStatus(row.status, t)} · v{row.revision}</span>
      <p className={css.body}>{row.body}</p>
      {row.status !== 'reverted' && <div className={css.row}>
        <Button variant="outline" size="sm" onClick={() => { void revert(workspaceId, row.id).then(refresh).catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) }) }}>{t('revert')}</Button>
      </div>}
    </li>)}</ul>
    {strict && <section className={css.section}>
      <h2 className={css.heading}>{t('proposed')} <span className={css.count}>{proposed.length}</span></h2>
      {proposed.length === 0 && <p>{t('proposedEmpty')}</p>}
      <ul className={css.list}>{proposed.map(row => <li key={`${row.id}:${row.revision}`} className={css.card}>
        <h3 className={css.heading}>{row.title}</h3>
        <span className={css.metadata}>{decisionSource(row)} · {decisionStatus(row.status, t)} · v{row.revision}</span>
        <p className={css.body}>{row.body}</p>
        <div className={css.row}>
          <Button variant="primary" size="sm" onClick={() => { void confirm(workspaceId, row.id, row.revision).then(refresh).catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) }) }}>{t('confirm')}</Button>
          <Button variant="outline" size="sm" onClick={() => { void reject(workspaceId, row.id, row.revision).then(refresh).catch((error: unknown) => { setFailure(error instanceof Error ? error.message : String(error)) }) }}>{t('reject')}</Button>
        </div>
      </li>)}</ul>
    </section>}
    <h2 className={css.heading}>{t('history')} <span className={css.count}>{past.length}</span></h2>
    {past.length === 0 && <p>{t('historyEmpty')}</p>}
    <ul className={css.list}>{past.map(row => <li key={`${row.id}:${row.revision}`} className={css.card}>
      <h3 className={css.heading}>{row.title}</h3>
      <span className={css.metadata}>{decisionSource(row)} · {decisionStatus(row.status === 'proposed' && revisionsOf(row.id).find(next => next.revision === row.revision + 1)?.status === 'rejected' ? 'rejected' : row.status, t)} · v{row.revision}</span>
      <p className={css.body}>{row.body}</p>
    </li>)}</ul>
  </section>
}
