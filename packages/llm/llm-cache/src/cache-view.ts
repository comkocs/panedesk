/** Cache-owned Remote bridge; every descendant is filtered using the invocation's resource grants. */
import { Context } from '@panedesk/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import type {} from '@panedesk/dsh-api-remote-access'
import type { SessionId } from '@panedesk/dsh-session'
import type { LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import type {} from './index.ts'
import { resolveCachePolicy } from './policy.ts'
import { cacheRemaining, foldCacheState } from './state.ts'
import type { CacheTier, SessionCacheRemainingRow, SessionCacheTierRequest, SessionCacheView, SessionCacheViewRequest } from './view-types.ts'

declare module '@panedesk/cordis' {
  interface Context {
    /** Cache-owned session evidence and tier operations. */
    cacheView: CacheViewService
  }
}

const TIERS: readonly CacheTier[] = ['none', '5m', '1h', '30m', '12h']

/** Session-scoped cache evidence and policy operations, independent of transcript control. */
export class CacheViewService extends TypertRemoteService {
  static inject = ['llmCache', 'agents', 'remoteAccess']

  constructor(ctx: Context) { super(ctx, 'cacheView') }

  /** Read the named session and its authorized descendants without creating an Agent.
   * @param request - session resource owned by the caller.
   * @returns ledger-derived readings, explicit supported tiers, and completeness.
   */
  @Remote({ resources: { session: request => request.sessionId } })
  async read(request: SessionCacheViewRequest): Promise<SessionCacheView> {
    this.assertSession(request.sessionId)
    const ledger = this.ctx.get('sessionLedger')
    const snapshot = await ledger?.snapshot()
    const readable = new Set<SessionId>([request.sessionId])
    if (snapshot?.complete) {
      let changed = true
      while (changed) {
        changed = false
        for (const row of snapshot.rows) {
          if (row.kind === 'event' || row.start.parentSessionId === undefined || !readable.has(row.start.parentSessionId)) continue
          const id = row.start.sessionId
          if (!readable.has(id) && this.ctx.remoteAccess.allows({ kind: 'session', id })) {
            readable.add(id)
            changed = true
          }
        }
      }
    }
    const rows: SessionCacheRemainingRow[] = []
    for (const id of readable) rows.push(await this.row(id, id === request.sessionId ? 'main' : 'subagent', snapshot))
    const agent = this.ctx.agents.get(request.sessionId)
    const provider = agent?.options.provider
    const route = provider === undefined ? undefined : this.ctx.llmCache.routeFor(provider)
    const tiers = ledger === undefined || route === undefined || route.capability === 'automatic' || route.capability === 'unsupported'
      ? [] : TIERS.filter((retention) => {
        try { resolveCachePolicy({ retention }, route, request.sessionId); return true }
        catch (_unsupportedTier) { return false }
      })
    const policy = agent === undefined ? undefined : this.ctx.llmCache.policy(agent)
    const retention = policy === undefined || route === undefined ? undefined
      : resolveCachePolicy(policy, route, request.sessionId).control.retention
    return { rows, tiers, adjustable: tiers.length > 0, complete: snapshot?.complete === true,
      ...retention === undefined ? {} : { retention } }
  }

  /** Store a supported tier while preserving the current stable cache key.
   * @param request - live session and a tier supported by its current provider route.
   * @returns completion of the cache policy's evidence writes; no model request is sent.
   */
  @Remote({ resources: { session: request => request.sessionId } })
  async setTier(request: SessionCacheTierRequest): Promise<void> {
    this.assertSession(request.sessionId)
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined || this.ctx.get('sessionLedger') === undefined) {
      throw new RemoteError('session/not-found', 'cache control is unavailable for this session', { sessionId: request.sessionId })
    }
    const provider = agent.options.provider
    const route = provider === undefined ? undefined : this.ctx.llmCache.routeFor(provider)
    if (route === undefined || route.capability === 'automatic' || route.capability === 'unsupported') {
      throw new RemoteError('gateway/bad-request', 'retention is not supported by this route', {})
    }
    const policy = { ...this.ctx.llmCache.policy(agent), retention: request.retention }
    try { resolveCachePolicy(policy, route, request.sessionId) }
    catch (_unsupportedTier) { throw new RemoteError('gateway/bad-request', 'retention is not supported by this route', {}) }
    await this.ctx.llmCache.update({ agent, policy })
  }

  private assertSession(sessionId: SessionId): void {
    if (sessionId.length === 0) throw new RemoteError('gateway/bad-request', 'sessionId must not be empty', {})
    if (!this.ctx.remoteAccess.allows({ kind: 'session', id: sessionId })) {
      throw new RemoteError('session/not-found', 'session is not visible', { sessionId })
    }
  }

  private async row(sessionId: SessionId, role: 'main' | 'subagent', snapshot: LedgerSnapshot | undefined): Promise<SessionCacheRemainingRow> {
    const filtered = snapshot === undefined ? undefined : { ...snapshot, rows: snapshot.rows.filter(row =>
      (row.kind === 'event' ? row.event.sessionId : row.start.sessionId) === sessionId) }
    const agent = this.ctx.agents.get(sessionId)
    const remaining = agent === undefined
      ? cacheRemaining(filtered === undefined ? undefined : foldCacheState(filtered), Date.now())
      : await this.ctx.llmCache.remaining(agent)
    const latest = filtered?.complete ? filtered.rows.filter(row => row.kind === 'call' && row.start.purpose === 'conversation')
      .sort((left, right) => (left.kind === 'call' ? left.start.startedAt : 0) - (right.kind === 'call' ? right.start.startedAt : 0)).at(-1) : undefined
    const hits = latest?.kind === 'call' ? latest.finish?.usage?.cacheReadTokens : undefined
    const reading = latest?.kind === 'call' && this.ctx.llmCache.routeFor(latest.start.provider).capability === 'automatic'
      ? { kind: 'automatic' as const } : remaining
    return { sessionId, role, ...reading,
      ...reading.kind === 'estimated' ? { seconds: Math.max(0, Math.round(reading.seconds)) } : {},
      ...hits === undefined ? {} : { cacheReadTokens: hits } }
  }
}
