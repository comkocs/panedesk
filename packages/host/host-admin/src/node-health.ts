/** Read-only node health joins provider observations without acquiring engine ownership. */
import type { Context } from '@panedesk/cordis'
import type * as Seat from '@panedesk/dsh-seat'
import type { SourceOperatorItem } from './source-operator.ts'
import type { HostAdminAuthority, HostAdminRequest, HostAdminResponse } from './index.ts'
import { executeLocal } from './local-executor.ts'

/** Safe process-local link observation shared with the optional transport provider. */
export interface NodeHealthEvent {
  sequence: number
  at: Seat.SeatTimestamp
  kind: 'connected' | 'disconnected' | 'reconnecting' | 'exhausted' | 'rebuild' | 'authentication-succeeded' | 'authentication-failed'
  safeReason: string | null
}
/** Transport contributes observations without introducing a dependency on its implementation. */
export interface NodeHealthPeer {
  nodeId: Seat.SeatNodeId
  nodeName: string
  reachable: boolean
  status: Seat.SeatNodeStatus | null
  safeReason: string | null
  exhausted?: boolean
  lastHeartbeatAt?: string | null
  events?: readonly NodeHealthEvent[]
}
declare module '@panedesk/cordis' {
  interface Context {
    /** Optional process-local peer health provider; absence means no configured peers. */
    hostAdminNodeHealth: { status(): Promise<readonly NodeHealthPeer[]> }
  }
}
/** Unknown peer counts remain null rather than appearing as empty capacity. */
export interface NodeHealthItem {
  nodeId: Seat.SeatNodeId
  nodeName: string
  local: boolean
  engine: Seat.SeatNodeStatus['engine']
  linkState: 'local' | 'connected' | 'reconnecting' | 'exhausted'
  safeReason: string | null
  openWindows: number | null
  limit: number | null
  lastHeartbeatAt: string | null
  events: readonly NodeHealthEvent[]
  rebuildable: boolean
}
/** Callback rows contain only operator evidence, never the frozen payload or routing credentials. */
export interface NodeHealthCallback {
  callbackId: Seat.CallbackId
  source: string
  target: string
  attempt: number
  phase: Seat.SeatCallbackDelivery['phase']
  parkingCode: string | null
  detail: string | null
  firstAttemptAt: string | null
  lastAttemptAt: string | null
  count: number
  attemptsAtLeast: boolean
  latestReason: string | null
  /** Split groups. Absent when the stored summary predates the split; never derived from `count`. */
  failures?: { count: number; firstAt: string | null; lastAt: string | null; attemptsAtLeast: boolean }
  directPending?: { count: number; firstAt: string | null; lastAt: string | null }
}
/** Engine observations retain their own revision; source work keeps the existing operator key. */
export interface NodeHealthView {
  nodes: NodeHealthItem[]
  callbacks: readonly NodeHealthCallback[]
  callbacksAvailable: boolean
  callbacksComplete: boolean
  sourceOperations: SourceOperatorItem[]
  sourceAvailable: boolean
}

/** Read only installed providers; missing providers never start a host or dispatch a callback.
 * @param ctx - Running host's provider registry.
 * @param limit - Bound applied to callback and source lists.
 * @returns Current local identity, peer observations and live callback retries.
 */
export async function readNodeHealth(ctx: Context, limit: number): Promise<NodeHealthView> {
  const engine = ctx.get('seatEngine'), router = ctx.get('hostAdminNodeHealth'), source = ctx.get('hostAdminSourceOperator')
  const local = engine ? await engine.nodeStatus() : undefined
  const peers = router ? await router.status() : []
  const callbacks = engine?.callbackObservations ? await engine.callbackObservations({ limit, phase: 'paused' }) : undefined
  const sources = source ? await source.list({ limit }) : undefined
  const nodes: NodeHealthItem[] = local ? [{ nodeId: local.nodeId, nodeName: local.nodeName, local: true,
    engine: local.engine, linkState: 'local', safeReason: local.failure?.code ?? null,
    openWindows: local.openEngineWindows, limit: local.limit, lastHeartbeatAt: null, events: [], rebuildable: false }] : []
  for (const peer of peers) {
    const isLocal = local !== undefined && peer.nodeId === local.nodeId
    if (isLocal) continue
    nodes.push({ nodeId: peer.nodeId, nodeName: peer.nodeName, local: false,
      engine: peer.status?.engine ?? 'unavailable',
      linkState: peer.exhausted ? 'exhausted' : peer.reachable ? 'connected' : 'reconnecting',
      safeReason: peer.exhausted ? 'node-tunnel-exhausted' : peer.safeReason, openWindows: peer.status?.openEngineWindows ?? null,
      limit: peer.status?.limit ?? null, lastHeartbeatAt: peer.lastHeartbeatAt ?? null,
      events: peer.events?.slice(-20) ?? [], rebuildable: local !== undefined && ctx.get('hostAdminTransport') !== undefined })
  }
  const parked = callbacks?.items.filter(item => item.phase === 'paused').map((item): NodeHealthCallback => {
    const diagnostic = item.lastDiagnostic ?? item.retrySummary?.lastDiagnostic
    return { callbackId: item.payload.callbackId, source: item.payload.sourceId,
      target: item.nodeWorkChain?.route.sourceOwnerNodeId ?? item.payload.sourceId,
      attempt: item.attempt, phase: item.phase, parkingCode: item.parkingClass ?? item.responseClass,
      detail: diagnostic?.cause.reasonCode ?? diagnostic?.cause.code ?? null,
      firstAttemptAt: item.retrySummary?.firstAttemptAt ?? null, lastAttemptAt: item.retrySummary?.lastAttemptAt ?? null,
      count: item.retrySummary?.count ?? item.attempt, attemptsAtLeast: item.retrySummary?.attemptsAtLeast ?? false,
      latestReason: diagnostic?.cause.reason ?? null,
      ...(item.retrySummary?.failures ? { failures: { count: item.retrySummary.failures.count,
        firstAt: item.retrySummary.failures.firstAt, lastAt: item.retrySummary.failures.lastAt,
        attemptsAtLeast: item.retrySummary.attemptsAtLeast ?? false } } : {}),
      ...(item.retrySummary?.directPending ? { directPending: { count: item.retrySummary.directPending.count,
        firstAt: item.retrySummary.directPending.firstAt, lastAt: item.retrySummary.directPending.lastAt } } : {}) }
  }) ?? []
  return { nodes, callbacks: parked, callbacksAvailable: callbacks !== undefined,
    callbacksComplete: callbacks?.complete ?? false, sourceOperations: sources?.items ?? [], sourceAvailable: source !== undefined }
}

/** Reuse the existing local authorization executor for a captured authenticated operator.
 * @param ctx - Running host provider registry.
 * @param request - Fixed existing administrative operation, never caller-provided authority.
 * @param authority - Host entry's authenticated local operator identity.
 * @param current - Live invocation and plugin lifetime check.
 * @returns Existing provider evidence, or null when its authorization dependencies are absent.
 */
export async function executeNodeOperator(ctx: Context, request: HostAdminRequest, authority: HostAdminAuthority,
  current: () => boolean): Promise<HostAdminResponse | null> {
  if (!current() || authority.kind !== 'local-operator') return null
  const engine = ctx.get('seatEngine')
  if (!engine) return null
  const local = await engine.nodeStatus()
  return executeLocal(ctx, request, authority, local.nodeId, 200, current)
}
