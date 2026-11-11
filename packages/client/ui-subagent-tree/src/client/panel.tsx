/** Subagent tree presentation: nested rows with per-node usage and a read-only monitoring modal. */
import { useState } from 'react'
import { IconPanedeskSubagentTree } from '@panedesk/dsh-client-ui-panedesk-icons'
import { Button, Modal, StateDot, Tag } from '@panedesk/dsh-client-ui-primitives'
import type { ResourceStatus } from '@panedesk/dsh-client-resources/client'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@panedesk/dsh-client-ui-slots'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { ActivityCategory } from '@panedesk/dsh-activity-category/types'
import type { SubagentTreeNode, SubagentTreeView } from '../types.ts'
import { NodeChecklist } from './checklist.tsx'
import type { SubagentTreeData } from './index.ts'
import type { SubagentTreeKey } from './locales.ts'
import { isActive, modelColor, type SubagentTreeUI } from './presentation.ts'
import css from './panel.module.css'
import { ActivityCell, ActivityTable, treeActivityTotals } from './activity.tsx'

/** Registration-side face for opening the tree tab of one session. */
export interface SubagentTreeActions {
  /** Open this session's tree page in the right sidebar. */
  open(this: void, sessionId: SessionId): void
}

/** Registration-side face for projecting session labels onto tree rows. */
export interface SubagentTreeLabels {
  /** Stop the node and its running descendants. */
  stop: SubagentTreeUI['stop']
  /** Open workspace verification settings. */
  openVerification(this: void): void
  /** Change subsequent-test policy for this exact task. */
  setTestsStopped(this: void, node: SubagentTreeNode, prohibited: boolean): Promise<void>
  /** Append one checklist category to the exact task's prohibitions. */
  prohibitChecklist(this: void, sessionId: SessionId, taskId: string, category: ActivityCategory): Promise<void>
  /** Display label of one session; falls back to its id at the registration site. */
  labelOf(this: void, sessionId: SessionId): string
}

/** Full props for the session-header subagent-tree pill. */
export type SubagentTreeActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'subagentTree'>
  & InjectFace<SubagentTreeActions>

/** Full props for the right-sidebar tree tab body. */
export type SubagentTreeTabProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'subagent.tree.details'>
  & PropsLocale<'subagentTree'>
  & InjectFace<SubagentTreeLabels>

/** Map one resource read onto the eight-state copy key. */
function stateKey(status: ResourceStatus, value: SubagentTreeData | undefined, code: string | undefined): SubagentTreeKey {
  if (code === 'subagentTree/unauthorized') return 'unauthorized'
  if (code === 'subagentTree/disabled') return 'disabled'
  if (status === 'failed') return value ? 'failed' : 'error'
  if (status === 'loading') return 'loading'
  if (!value) return 'noSession'
  if (!value.complete) return 'partial'
  return value.root.children.length === 0 ? 'empty' : 'success'
}

/**
 * Session-header pill that opens this session's tree page.
 * @param props - Session standard props, localized copy, and the open action.
 * @returns One toolbar button inside an open session's header, or null for the minimal preset.
 */
export function SubagentTreeAction({ sessionId, useSessions, t, open }: SubagentTreeActionProps) {
  const minimal = useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset === 'minimal')
  if (minimal) return null
  return <Button variant="toolbar" size="sm" className={css.pill} onClick={() => { open(sessionId) }}>
    <IconPanedeskSubagentTree />{t('title')}
  </Button>
}

/** One row's display columns. */
interface RowModel {
  node: SubagentTreeNode
  depth: number
  label: string
}

function totalTokens(node: SubagentTreeNode): number | null {
  const tokens = node.tokens
  return tokens.inputTokens === null || tokens.outputTokens === null ? null
    : tokens.inputTokens + tokens.outputTokens + (tokens.cacheReadTokens ?? 0)
      + (tokens.cacheWriteTokens ?? 0) + (tokens.cacheWriteShortTokens ?? 0) + (tokens.cacheWriteLongTokens ?? 0)
}

function flattenRows(root: SubagentTreeNode, labelOf: (sessionId: SessionId) => string): readonly RowModel[] {
  const rows: RowModel[] = []
  const walk = (node: SubagentTreeNode, depth: number): void => {
    rows.push({ node, depth, label: node.external?.title ?? labelOf(node.sessionId) })
    for (const child of node.children) walk(child, depth + 1)
  }
  walk(root, 0)
  return rows
}

/**
 * Right-sidebar tree tab: nested node rows plus the monitoring modal.
 * @param props - Framework tab props, localized copy, and the resource reader.
 * @returns The tree table with per-row monitoring and active-node Stop controls.
 */
export function SubagentTreeTab({ useResource, useTabInfo, useSessions, useWorkspaces, renderSlot, t, labelOf, stop, openVerification, setTestsStopped, prohibitChecklist }: SubagentTreeTabProps) {
  const [verificationError, setVerificationError] = useState(false)
  const [stopError, setStopError] = useState(false)
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())
  const stopNode = async (node: SubagentTreeNode): Promise<void> => {
    setStopError(false)
    setStopping(ids => new Set(ids).add(node.sessionId))
    try { await stop(node) } catch (_stopFailed) { setStopError(true) }
    finally { setStopping(ids => new Set([...ids].filter(id => id !== node.sessionId))) }
  }
  const { tab } = useTabInfo()
  const resource = useResource<'subagenttree'>(tab.contentId)
  const [monitoredId, setMonitoredId] = useState<string | null>(null)
  const view: SubagentTreeView | undefined = resource.value
  const message = stateKey(resource.status, resource.value, resource.failure?.code)
  const rows = view === undefined ? [] : flattenRows(view.root, labelOf)
  const nodeKey = (node: SubagentTreeNode): string => `${node.external ? 'external' : 'native'}:${node.sessionId}`
  const monitored = rows.find(row => nodeKey(row.node) === monitoredId)
  const number = (value: number | null | undefined): string => value === null || value === undefined ? t('unknown') : String(value)
  const time = (value: number): string => new Intl.DateTimeFormat(undefined,
    { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(value)
  return <section className={css.tab} data-subagent-tree="">
    <h1 className={css.heading}>{t('title')}</h1>
    <Button variant="outline" onClick={openVerification}>{t('verification')}</Button>
    {verificationError && <p role="alert">{t('verificationFailed')}</p>}
    <p>{t('description')}</p>
    <p>{t('transcriptNote')}</p>
    <p role={resource.status === 'failed' ? 'alert' : 'status'} aria-live="polite">{t(message)}</p>
    {stopError && <p role="alert">{t('stopFailed')}</p>}
    {view?.externalRegistryUnreadable && <p role="alert">{t('registryError')}</p>}
    <p>{t('activityNote')}</p>
    {view && <details><summary>{t('treeTotals')}</summary><ActivityTable totals={treeActivityTotals(rows.map(row => row.node))} t={t} /></details>}
    {view && <table className={css.table}>
      <caption className={css.caption}>{t('title')}</caption>
      <thead><tr>
        <th scope="col">{t('session')}</th>
        <th scope="col">{t('status')}</th>
        <th scope="col" className={css.activityColumn}>{t('activity')}</th>
        <th scope="col">{t('model')}</th>
        <th scope="col">{t('tokens')}</th>
        <th scope="col">{t('cacheHitRate')}</th>
        <th scope="col"><span aria-hidden="true">{t('monitor')}</span></th>
      </tr></thead>
      <tbody>{rows.map(({ node, depth, label }) => <tr key={nodeKey(node)}
        onClick={() => { setMonitoredId(nodeKey(node)) }}>
        <td style={{ paddingLeft: `${8 + depth * 18}px` }}>
          <StateDot className={css.statusDot} state={isActive(node.status) ? 'done' : 'idle'} />
          <span className={css.label}>{label}</span>
          {node.external && <><Tag>{t('external')}</Tag><small> · {node.external.type}</small></>}
        </td>
        <td className={css.status} data-end-reason={node.endReason}>{t(node.status)}{node.status === 'finished' && node.endReason !== undefined ? ` · ${t(node.endReason === 'error' ? 'errored' : node.endReason)}` : ''}</td>
        <td className={css.activityColumn}><ActivityCell activity={node.external ? null : node.activity} t={t} />
          {!node.external && node.parentSessionId !== null && isActive(node.status) && node.verificationTaskId !== undefined && <label onClick={event => { event.stopPropagation() }}>
            <input key={node.verificationTaskId} type="checkbox" checked={node.testsStopped ?? false}
              onChange={event => {
                setVerificationError(false)
                void setTestsStopped(node, event.target.checked).catch((_error: unknown) => { setVerificationError(true) })
              }} />{t(node.testsStopped ? 'testsStopped' : 'stopTests')}
          </label>}
        </td>
        <td style={{ color: modelColor(node.model) }}>{node.model ?? t(node.external ? 'unknown' : 'modelUnknown')}</td>
        <td className={css.numbers}>
          {node.contextTokens === undefined ? t('contextUnknown') : t('context', { value: new Intl.NumberFormat(undefined,
            { notation: 'compact', maximumFractionDigits: 1 }).format(node.contextTokens) })}
          {' · '}{t('totalTokens')}: {number(totalTokens(node))}
        </td>
        <td>{node.cacheHitRate === null ? t('unknown') : `${Math.round(node.cacheHitRate * 100)}%`}</td>
        <td><Button variant="ghost" className={css.monitorButton} onClick={() => { setMonitoredId(nodeKey(node)) }}>{t('monitor')}</Button>
          {isActive(node.status) && <Button variant="ghost" className={css.stop} disabled={stopping.has(node.sessionId)}
            onClick={event => { event.stopPropagation(); void stopNode(node) }}>{t('stop')}</Button>}</td>
      </tr>)}</tbody>
    </table>}
    <Modal open={monitored !== undefined} onClose={() => { setMonitoredId(null) }}
      title={t('monitorTitle')} closeLabel={t('monitorClose')} contentClassName={css.monitorContent ?? ''}>
      {monitored !== undefined && <>
        {!monitored.node.external && monitored.node.parentSessionId !== null && renderSlot('subagent.tree.details', {
          parentSessionId: monitored.node.parentSessionId, childSessionId: monitored.node.sessionId,
          label: monitored.label, close: () => { setMonitoredId(null) },
        })}
        <MonitoringView node={monitored.node} label={monitored.label} t={t} number={number} time={time} />
        <h3>{t('activityTotals')}</h3>
        <ActivityTable totals={monitored.node.external ? undefined : monitored.node.activity?.totals} t={t} />
        {!monitored.node.external && <NodeChecklist sessionId={monitored.node.sessionId} taskId={monitored.node.verificationTaskId}
          totals={monitored.node.activity?.totals} useSessions={useSessions} useWorkspaces={useWorkspaces} useResource={useResource}
          prohibit={prohibitChecklist} t={t} />}
      </>}
    </Modal>
  </section>
}

/** Read-only monitoring facts for one node; every column states its value or its unknown. */
function MonitoringView({ node, label, t, number, time }: {
  node: SubagentTreeNode
  label: string
  t: PropsLocale<'subagentTree'>['t']
  number: (value: number | null | undefined) => string
  time: (value: number) => string
}) {
  const modelText = node.model !== null ? node.model : t(node.external ? 'unknown' : node.modelSource === 'unreadable' ? 'unreadable' : node.modelSource === 'unavailable' ? 'unavailable' : 'modelUnknown')
  const rows: readonly { key: SubagentTreeKey; value: string }[] = [
    { key: 'session', value: label },
    { key: 'status', value: t(node.status) + (node.status === 'finished' && node.endReason !== undefined ? ` · ${t(node.endReason === 'error' ? 'errored' : node.endReason)}` : '') },
    { key: 'liveness', value: t(node.liveness) },
    { key: 'model', value: modelText },
    ...(node.external ? [
      { key: 'external' as const, value: node.external.type },
      { key: 'startedAt' as const, value: node.external.startedAt === null ? t('unknown') : time(node.external.startedAt) },
      { key: 'endedAt' as const, value: node.external.endedAt === null ? t('unknown') : time(node.external.endedAt) },
    ] : []),
    { key: 'contextTokens', value: number(node.contextTokens) },
    { key: 'totalTokens', value: number(totalTokens(node)) },
    { key: 'inputTokens', value: number(node.tokens.inputTokens) },
    { key: 'cacheReadTokens', value: number(node.tokens.cacheReadTokens) },
    { key: 'cacheWriteShortTokens', value: number(node.tokens.cacheWriteShortTokens) },
    { key: 'cacheWriteLongTokens', value: number(node.tokens.cacheWriteLongTokens) },
    { key: 'cacheWriteTokens', value: number(node.tokens.cacheWriteTokens) },
    { key: 'outputTokens', value: number(node.tokens.outputTokens) },
    { key: 'usageState', value: t(node.usageState === 'partial' ? 'partialUsage' : node.usageState === 'complete' ? 'complete' : 'missing') },
    { key: 'cacheHitRate', value: node.cacheHitRate === null ? t('unknown') : `${Math.round(node.cacheHitRate * 100)}%` },
    { key: 'elapsed', value: node.elapsedMs === null ? t('unknown') : `${node.elapsedMs} ms` },
    { key: 'runs', value: String(node.runs) },
    { key: 'calls', value: String(node.calls) },
    { key: 'lastToolCall', value: node.lastToolCall === null ? t('noToolCall') : `${node.lastToolCall.name} ${t('lastToolCallAt', { time: time(node.lastToolCall.time) })}` },
    { key: 'seat', value: node.seat ?? t('noSeat') },
    { key: 'taskId', value: node.taskId ?? t('noTask') },
    { key: 'children', value: String(node.children.length) },
  ]
  return <dl className={css.monitor}>
    {rows.map(row => <div className={css.monitorRow} key={row.key}>
      <dt>{t(row.key)}</dt>
      <dd>{row.value}</dd>
    </div>)}
    <p className={css.monitorNote}>{t('transcriptNote')}</p>
  </dl>
}
