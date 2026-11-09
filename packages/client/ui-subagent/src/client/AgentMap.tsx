/** Composer map over shared subagent projections and read-only job streams. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { IJobs, JobView } from '@panedesk/dsh-api-job-controller/client'
import type { SessionProjectionMap, SessionProjectionSnapshot } from '@panedesk/dsh-api-session-controller/client'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime, TranslateNS } from '@panedesk/dsh-client-ui-slots'
import { Button, IconBranchOutlineRegular, Modal, StateDot } from '@panedesk/dsh-client-ui-primitives'
import type { SubagentCatalogInjected } from './SubagentHeaderLineage.tsx'
import type { SubagentTreeUI, SubagentTreeNode } from '@panedesk/dsh-client-ui-subagent-tree/client'
import type {} from '@panedesk/dsh-token-meter/client'
import { NS } from './locales.ts'
import css from './AgentMap.module.css'

/** Registration-owned tree facts, model styling and agent/job stop actions. */
export interface AgentMapInjected extends SubagentCatalogInjected {
  hooks: { jobs: IJobs['state'] }
  watchRows: IJobs['watchRows']
  observe: IJobs['observe']
  treeAddress: SubagentTreeUI['address']
  modelColor: SubagentTreeUI['modelColor']
  isActive: SubagentTreeUI['isActive']
  stopAgent: SubagentTreeUI['stop']
  killJob(sessionId: SessionId, jobId: JobView['id']): Promise<void>
}

type MapProps = PropsRuntime<'conversation.input.left'> & PropsRenderFactories
  & PropsLocale<typeof NS> & InjectFace<AgentMapInjected>
type Entry = SessionProjectionMap['subagentCatalog'][number]
interface Branch {
  entry: Entry
  parent: SessionId
  node: SubagentTreeNode
  children: Branch[]
  width: number
}
interface PlacedNode {
  branch: Branch
  x: number
  y: number
}
const CARD_WIDTH = 240
const CARD_HEIGHT = 76
const COLUMN = CARD_WIDTH + 12
const ROW = CARD_HEIGHT + 32

function branches(root: SubagentTreeNode, projections: Readonly<Record<SessionId, SessionProjectionSnapshot>>): Branch[] {
  return root.children.map(node => {
    const catalog = projections[root.sessionId]?.values.subagentCatalog?.find(entry => entry.id === node.sessionId)
    const entry: Entry = node.external
      ? { id: node.sessionId, mode: 'external', label: node.external.title, createdAt: node.external.startedAt ?? 0 }
      : catalog ?? { id: node.sessionId, mode: 'unknown', createdAt: 0 }
    const children = branches(node, projections)
    return { entry, parent: root.sessionId, node, children, width: Math.max(COLUMN, children.reduce((sum, child) => sum + child.width, 0)) }
  })
}

/** Pack sibling subtrees on horizontal buses below the main session's own row. */
function layout(tree: Branch[]) {
  const breadth = (items: Branch[]): number => items.reduce((sum, item) => sum + item.width, 0)
  const depth = (items: Branch[]): number => items.length === 0 ? 0 : 1 + Math.max(...items.map(item => depth(item.children)))
  const width = Math.max(COLUMN, breadth(tree)) + 32
  const center = { x: width / 2, y: CARD_HEIGHT / 2 + 16 }
  const height = depth(tree) * ROW + CARD_HEIGHT + 32
  const nodes: PlacedNode[] = []
  const paths: string[] = []
  const place = (items: Branch[], parent: { x: number; y: number }, left: number): void => {
    let offset = left
    for (const branch of items) {
      const x = offset + branch.width / 2
      const y = parent.y + ROW
      nodes.push({ branch, x, y })
      const bus = parent.y + ROW / 2
      paths.push(`M${parent.x},${parent.y + CARD_HEIGHT / 2} V${bus} H${x} V${y - CARD_HEIGHT / 2}`)
      place(branch.children, { x, y }, offset)
      offset += branch.width
    }
  }
  place(tree, center, (width - breadth(tree)) / 2)
  return { width, height, center, nodes, paths }
}

function duration(ms: number, t: TranslateNS<typeof NS>): string {
  const total = Math.floor(Math.max(0, ms) / 1000)
  if (total >= 3600) return t('duration.hours', { hours: Math.floor(total / 3600), minutes: Math.floor(total / 60) % 60, seconds: total % 60 })
  if (total >= 60) return t('duration.minutes', { minutes: Math.floor(total / 60), seconds: total % 60 })
  return t('duration.seconds', { seconds: total })
}

function tokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function jobStatus(job: JobView, t: TranslateNS<typeof NS>): string {
  switch (job.status) {
    case 'running': return t('activity.running')
    case 'stopping': return t('map.stopping')
    case 'completed': return t('activity.completed')
    case 'killed': return t('map.killed')
    case 'failed': return t('activity.failed')
  }
}

/**
 * Show an input-footer entry and a zoomable, pannable descendant map.
 * @param props - Session-bound hooks, navigation, read-only jobs and localized copy.
 * @returns The trigger and its dismissible map panel.
 */
export function AgentMap({ sessionId, useSessions, useSessionStatus, useProjection, useJobs, watchRows, observe,
  refreshProjection, openChild, renderFactorySlot, useResource, treeAddress, modelColor, isActive, stopAgent, killJob, t }: MapProps) {
  const resource = useResource<'subagenttree'>(treeAddress(sessionId))
  const facts = useMemo(() => {
    const result = new Map<SessionId, SubagentTreeNode>()
    const visit = (node: SubagentTreeNode): void => {
      result.set(node.sessionId, node)
      node.children.forEach(visit)
    }
    if (resource.value) visit(resource.value.root)
    return result
  }, [resource.value])
  const [stopError, setStopError] = useState<string>()
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())
  const stop = async (id: string, label: string, action: () => Promise<void>): Promise<void> => {
    setStopError(undefined)
    setStopping(ids => new Set(ids).add(id))
    try { await action() } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      switch (code) {
        case 'subagent/unauthorized':
        case 'subagentTree/unauthorized':
          setStopError(t('map.stopUnauthorized', { label }))
          break
        case 'session/not-found':
        case 'subagent/not-found':
        case 'job/not-found':
          setStopError(t('map.stopEnded', { label }))
          break
        case 'gateway/internal':
        case 'subagentTree/unavailable':
          setStopError(t('map.stopDisconnected', { label }))
          break
        default:
          setStopError(t('map.stopFailed', { label }))
      }
    } finally { setStopping(ids => new Set([...ids].filter(value => value !== id))) }
  }
  const projections = useSessions(state => state.projectionsBySession)
  const summaries = useSessions(state => state.byId)
  const statuses = useSessionStatus(value => value)
  const selection = useProjection('modelSelection')
  const context = useProjection('contextPressure')
  const rootUsage = useProjection('tokenUsage')
  const rows = useJobs(state => state.rows[sessionId])
  const observed = useJobs(state => state.observed)
  const jobs = useMemo(() => (rows ?? []).filter(job => job.kind === 'bash' || job.kind === 'pwsh'), [rows])
  const tree = useMemo(() => resource.value === undefined ? [] : branches(resource.value.root, projections), [resource.value, projections])
  const graph = useMemo(() => layout(tree), [tree])
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<{ kind: 'agent'; id: SessionId } | { kind: 'job'; id: JobView['id'] }>()
  const [now, setNow] = useState(Date.now)
  const requested = useRef(new Set<SessionId>())
  const viewport = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 })
  const autoFit = useRef(true)
  const drag = useRef<{ pointerId: number; x: number; y: number; origin: typeof view; moved: boolean }>()
  const [dragging, setDragging] = useState(false)
  const fit = useCallback(() => {
    const element = viewport.current
    if (!element) return
    const scale = Math.min(1, element.clientWidth / graph.width, element.clientHeight / graph.height)
    setView({ x: (element.clientWidth - graph.width * scale) / 2, y: (element.clientHeight - graph.height * scale) / 2, scale })
    autoFit.current = true
  }, [graph.width, graph.height])
  const zoom = useCallback((factor: number, x: number, y: number) => {
    autoFit.current = false
    setView(current => {
      const scale = Math.max(0.3, Math.min(2, current.scale * factor))
      return { x: x - (x - current.x) * scale / current.scale, y: y - (y - current.y) * scale / current.scale, scale }
    })
  }, [])
  const zoomCenter = (factor: number) => {
    const element = viewport.current!
    zoom(factor, element.clientWidth / 2, element.clientHeight / 2)
  }

  useEffect(() => watchRows(sessionId), [sessionId, watchRows])
  useEffect(() => {
    if (!open) {
      requested.current.clear()
      return
    }
    for (const id of [sessionId, ...graph.nodes.filter(node => node.branch.entry.mode !== 'external').map(node => node.branch.entry.id)]) {
      const snapshot = projections[id]
      if (summaries[id]?.formatStatus === 'migration-required' || snapshot?.state === 'migration-required') continue
      if (snapshot?.values.subagentCatalog !== undefined || snapshot?.state === 'loading' || snapshot?.state === 'error' || requested.current.has(id)) continue
      requested.current.add(id)
      refreshProjection(id)
    }
  }, [open, sessionId, graph, projections, summaries, refreshProjection])
  const moving = jobs.some(job => job.status === 'running' || job.status === 'stopping')
    || graph.nodes.some(({ branch }) => statuses.get(branch.entry.id)?.running ?? summaries[branch.entry.id]?.running)
  useEffect(() => {
    if (!open || !moving) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open, moving])
  // Fit needs the viewport's pixel dimensions; CSS cannot derive a transform scale from both axes.
  useEffect(() => {
    const element = viewport.current
    if (!open || !element) return
    const resize = new ResizeObserver(() => { if (autoFit.current) fit() })
    resize.observe(element)
    if (autoFit.current) fit()
    return () => resize.disconnect()
  }, [open, fit])
  useEffect(() => {
    const element = viewport.current
    if (!open || !element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      zoom(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left - element.clientLeft, event.clientY - rect.top - element.clientTop)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [open, zoom])

  const activeJob = open && selected?.kind === 'job' ? jobs.find(job => job.id === selected.id) : undefined
  const jobId = activeJob?.id
  useEffect(() => {
    if (jobId !== undefined) return observe(sessionId, jobId)
  }, [sessionId, jobId, observe])
  const activeBranch = selected?.kind === 'agent' ? graph.nodes.find(node => node.branch.entry.id === selected.id)?.branch : undefined
  const jobView = activeJob === undefined ? undefined : observed[activeJob.id]
  const describe = (branch: Branch) => {
    const summary = summaries[branch.entry.id]
    const values = projections[branch.entry.id]?.values ?? summary?.projectionValues
    const fact = facts.get(branch.entry.id)
    const timing = values?.subagentTiming ?? summary?.projectionValues?.subagentTiming
    const running = fact !== undefined ? isActive(fact.status)
      : timing !== undefined ? timing.active !== undefined
        : (statuses.get(branch.entry.id)?.running ?? summary?.running) === true
    const usage = values?.tokenUsage ?? summary?.projectionValues?.tokenUsage
    const pressure = values?.contextPressure?.pressureTokens ?? summary?.projectionValues?.contextPressure?.pressureTokens ?? fact?.contextTokens
    const elapsed = timing === undefined ? undefined : timing.settledMs + (timing.active === undefined ? 0
      : Math.max(0, (running ? now : timing.active.through) - timing.active.since))
    const state = running ? 'done' : 'idle'
    const stopped = !running && (fact?.endReason === 'cancelled' || fact?.endReason === 'killed')
    const status = stopped ? t('map.killed') : stopping.has(branch.entry.id) ? t('map.stopping')
      : running ? t('activity.running') : timing?.lastTurnCompleted ? t('activity.completed') : t('activity.inactive')
    const model = fact?.model ?? null
    const usageMetrics = [pressure === undefined ? t('map.contextUnknown') : t('map.context', { value: tokens(pressure) }),
      usage === undefined ? fact?.tokens.inputTokens == null || fact.tokens.outputTokens === null ? t('map.totalUnknown')
        : t('map.total', { value: tokens(fact.tokens.inputTokens + fact.tokens.outputTokens + (fact.tokens.cacheReadTokens ?? 0)
          + (fact.tokens.cacheWriteTokens ?? 0) + (fact.tokens.cacheWriteShortTokens ?? 0) + (fact.tokens.cacheWriteLongTokens ?? 0)) })
        : t('map.total', { value: tokens(usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) })].join(' · ')
    const metrics = [model ?? t('map.modelUnknown'), elapsed === undefined
      ? fact?.elapsedMs === null || fact?.elapsedMs === undefined ? undefined : duration(fact.elapsedMs, t)
      : duration(elapsed, t)].filter(Boolean).join(' · ')
    return { label: branch.entry.label || summary?.displayTitle || t('map.titlePending'), status, state, metrics, usageMetrics, model, running, stopped } as const
  }
  const rootTitle = summaries[sessionId]?.displayTitle || t('map.titlePending')
  const contextTokens = context?.pressureTokens
  const rootFact = facts.get(sessionId)
  const rootModel = rootFact?.model ?? selection?.lastUsed?.model ?? null
  const rootRunning = rootFact !== undefined ? isActive(rootFact.status)
    : (statuses.get(sessionId)?.running ?? summaries[sessionId]?.running) === true
  const rootStopped = !rootRunning && (rootFact?.endReason === 'cancelled' || rootFact?.endReason === 'killed')
  const rootMetrics = rootModel ?? t('map.modelUnknown')
  const rootUsageMetrics = [contextTokens === undefined ? t('map.contextUnknown') : t('map.context', { value: tokens(contextTokens) }),
    rootUsage === undefined ? t('map.totalUnknown') : t('map.total', {
      value: tokens(rootUsage.uncachedInputTokens + rootUsage.outputTokens + rootUsage.cacheReadTokens + rootUsage.cacheWriteTokens),
    })].join(' · ')
  const selectedInfo = activeBranch === undefined ? undefined : describe(activeBranch)
  const count = graph.nodes.length + jobs.length
  const close = (): void => { setOpen(false); setSelected(undefined) }

  return <>
    <button type="button" className={css.trigger} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { setNow(Date.now()); setOpen(true) }}>
      <IconBranchOutlineRegular size={14} />{t('map.title')}{count > 0 && <span>{count}</span>}
    </button>
    <Modal open={open} onClose={close} title={t('map.title')} closeLabel={t('map.close')}
      description={t('map.agents', { count: graph.nodes.length })} className={css.panel!} contentClassName={css.content!}>
      <div className={css.body}>
        <div className={css.main}>
          {stopError && <p role="alert">{stopError}</p>}
          {resource.status === 'failed' && <p role="alert">{t('map.factsFailed')}</p>}
          {resource.value?.externalRegistryUnreadable && <p role="alert">{t('map.registryFailed')}</p>}
          <div ref={viewport} className={css.viewport} data-dragging={dragging} aria-label={t('tree.aria')} tabIndex={0}
            onPointerDown={event => {
              if (event.button !== 0 || (event.target as HTMLElement).closest('[data-map-card], button')) return
              drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: view, moved: false }
              event.currentTarget.setPointerCapture(event.pointerId)
              event.preventDefault()
            }}
            onPointerMove={event => {
              const start = drag.current
              if (!start || start.pointerId !== event.pointerId) return
              const dx = event.clientX - start.x
              const dy = event.clientY - start.y
              if (!start.moved && Math.hypot(dx, dy) <= 5) return
              start.moved = true
              autoFit.current = false
              setDragging(true)
              setView({ ...start.origin, x: start.origin.x + dx, y: start.origin.y + dy })
            }}
            onPointerUp={event => {
              if (drag.current?.pointerId === event.pointerId) event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onLostPointerCapture={() => { drag.current = undefined; setDragging(false) }}
            onPointerCancel={() => { drag.current = undefined; setDragging(false) }}
            onDoubleClick={event => { if (!(event.target as HTMLElement).closest('[data-map-card], button')) fit() }}>
            <div className={css.canvas} style={{ width: graph.width, height: graph.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
              <svg className={css.connections} width={graph.width} height={graph.height} aria-hidden="true">
                <path d={graph.paths.join(' ')} />
              </svg>
              <div data-map-root="" data-map-card="" className={`${css.card} ${css.node} ${css.root}`}
                style={{ left: graph.center.x - CARD_WIDTH / 2, top: graph.center.y - CARD_HEIGHT / 2, borderLeftColor: modelColor(rootModel) }} title={`${rootTitle} · ${rootMetrics}`}>
                <span className={css.title}><StateDot className={css.statusDot} state={rootRunning ? 'done' : 'idle'} size={10} /><span className={css.mainLabel}>{t('map.main')}</span>{rootTitle}</span>
                <span className={css.metrics}>{rootStopped ? t('map.killed') + ' · ' : ''}{rootMetrics}</span>
                <span className={css.metrics}>{rootUsageMetrics}</span>
              </div>
              {graph.nodes.map(({ branch, x, y }) => {
                const info = describe(branch)
                return <div key={branch.entry.id} data-map-card="" data-stopped={info.stopped} className={`${css.card} ${css.node}`}
                  style={{ left: x - CARD_WIDTH / 2, top: y - CARD_HEIGHT / 2, borderLeftColor: modelColor(info.model) }}>
                  <button type="button" className={css.cardSelect}
                    aria-pressed={selected?.kind === 'agent' && selected.id === branch.entry.id}
                    title={[info.label, info.status, info.metrics, info.usageMetrics].join(' · ')}
                    onClick={() => setSelected({ kind: 'agent', id: branch.entry.id })}>
                    <span className={css.title}><StateDot className={css.statusDot} state={info.state} size={10} />{info.label}</span>
                    <span className={css.metrics}>{info.stopped ? t('map.killed') + ' · ' : ''}{info.metrics}</span>
                    <span className={css.metrics}>{info.usageMetrics}</span>
                  </button>
                  {info.running && <button type="button" className={css.stop} aria-label={t('map.stop')} title={t('map.stop')}
                    disabled={stopping.has(branch.entry.id)} onClick={() => { void stop(branch.entry.id, info.label,
                      () => stopAgent(branch.node)) }}>■</button>}
                </div>
              })}
            </div>
            <div className={css.controls}>
              <Button variant="ghost" size="sm" onClick={fit}>{t('map.fit')}</Button>
              <Button variant="ghost" size="sm" onClick={() => zoomCenter(1 / view.scale)}>{t('map.actualSize')}</Button>
              <Button variant="ghost" size="sm" aria-label={t('map.zoomIn')} onClick={() => zoomCenter(1.25)}>{t('map.plus')}</Button>
              <Button variant="ghost" size="sm" aria-label={t('map.zoomOut')} onClick={() => zoomCenter(0.8)}>{t('map.minus')}</Button>
            </div>
          </div>
          {[sessionId, ...graph.nodes.filter(node => node.branch.entry.mode !== 'external').map(node => node.branch.entry.id)].map(id => {
            const snapshot = projections[id]
            if (snapshot?.state === 'error') return <div key={id}>{summaries[id]?.displayTitle ?? id}: {t('load.error')}{' '}
              <button type="button" className={css.action} onClick={() => refreshProjection(id)}>{t('retry')}</button></div>
            if (snapshot?.state === 'migration-required' || summaries[id]?.formatStatus === 'migration-required') return <p key={id}>{summaries[id]?.displayTitle ?? id}: {t('catalog.migrationRequired')}</p>
            if (snapshot?.values.subagentCatalog === undefined) return <p key={id} className={css.heading}>{t(snapshot?.state === 'ready' ? 'map.unavailable' : 'loading.label')}</p>
            return null
          })}
          {jobs.length > 0 && <section className={css.tasks}>
            <h3 className={css.heading}>{t(jobs.some(job => job.status === 'running' || job.status === 'stopping') ? 'map.tasks' : 'map.tasksFinished', { count: jobs.length })}</h3>
            <div className={css.taskCards}>{jobs.map(job => <div key={job.id} className={css.card}>
              <button type="button" className={css.cardSelect}
                aria-pressed={selected?.kind === 'job' && selected.id === job.id} title={job.label}
                onClick={() => setSelected({ kind: 'job', id: job.id })}>
                <span className={css.title}><StateDot className={css.statusDot} state={isActive(job.status) ? 'done' : 'idle'} size={10} />{job.label}</span>
                <span className={css.metrics} title={jobStatus(job, t)}>
                  {jobStatus(job, t)} · {t('map.shell', { duration: duration((job.finishedAt ?? now) - job.startedAt, t) })}
                </span>
              </button>
              {isActive(job.status) && <button type="button" className={css.stop} aria-label={t('map.stop')} title={t('map.stop')}
                disabled={stopping.has(job.id)} onClick={() => { void stop(job.id, job.label, () => killJob(sessionId, job.id)) }}>■</button>}
            </div>)}</div>
          </section>}
        </div>
        {(activeBranch !== undefined || activeJob !== undefined) && <aside className={css.details}>
          {activeBranch !== undefined && selectedInfo !== undefined && <>
            {selectedInfo.running && <button type="button" className={`${css.action} ${css.stopAction}`}
              disabled={stopping.has(activeBranch.entry.id)} onClick={() => { void stop(activeBranch.entry.id, selectedInfo.label,
                () => stopAgent(activeBranch.node)) }}>{t('map.stop')}</button>}
            {activeBranch.entry.mode === 'external'
            ? <><h3>{selectedInfo.label}</h3><p>{selectedInfo.status}</p><p style={{ color: modelColor(selectedInfo.model) }}>{selectedInfo.metrics} · {selectedInfo.usageMetrics}</p></>
            : <>
              <button type="button" className={css.action} onClick={() => {
                if (activeBranch.entry.mode === 'external') return
                openChild({ parentSessionId: activeBranch.parent, childSessionId: activeBranch.entry.id, mode: activeBranch.entry.mode })
                close()
              }}>{t('map.open')}</button>
              {renderFactorySlot('subagent.task-preview', {
                address: { parentSessionId: activeBranch.parent, childSessionId: activeBranch.entry.id, mode: activeBranch.entry.mode },
                label: selectedInfo.label, status: selectedInfo.status, metrics: `${selectedInfo.metrics} · ${selectedInfo.usageMetrics}`,
              })}
            </>}
          </>}
          {activeJob !== undefined && <>
            {isActive(activeJob.status) && <button type="button" className={`${css.action} ${css.stopAction}`}
              disabled={stopping.has(activeJob.id)} onClick={() => { void stop(activeJob.id, activeJob.label, () => killJob(sessionId, activeJob.id)) }}>{t('map.stop')}</button>}
            <h3>{t('map.command')}</h3><pre className={css.output}>{activeJob.label}</pre>
            <p>{jobStatus(activeJob, t)}{activeJob.detail && ` · ${activeJob.detail}`}</p>
            <h3>{t('map.output')}</h3>
            {jobView?.gapBefore && <p>{t('map.outputGap')}</p>}
            {jobView?.error !== undefined && <p role="alert">{t('map.outputError', { error: jobView.error })}</p>}
            <pre className={css.output}>{jobView === undefined ? t('map.outputLoading') : jobView.text || t('map.outputEmpty')}</pre>
          </>}
        </aside>}
      </div>
    </Modal>
  </>
}
