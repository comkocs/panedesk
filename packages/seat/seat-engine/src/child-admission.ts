/** Seat-owned child capacity uses durable tickets before entering the upstream manager. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'
import type { SessionId } from '@panedesk/dsh-session'
import type { SubagentActivationSpec, SubagentAdmission, SubagentReservation } from '@panedesk/dsh-subagent'
import type { ChildAdmissionTicket, ChildTicketId, OwnerEpoch, SeatDefinition, SeatJson } from '@panedesk/dsh-seat'
import type { SeatEngine } from './engine.ts'
import { canonical, digest, EngineError } from './journal.ts'
import { fact } from './triggers.ts'

type FrozenActivation = Omit<SubagentActivationSpec, 'request' | 'signal'> & {
  request: Omit<SubagentActivationSpec['request'], 'parent'>
}

/** Reservations and replay are owned by the same provider lifecycle. */
export class ChildAdmissionProvider implements SubagentAdmission {
  private readonly queued = new Map<ChildTicketId, SubagentActivationSpec>()
  private readonly grants = new Map<SubagentActivationSpec, ChildAdmissionTicket>()
  private active: Promise<void> | undefined
  private stopped = false
  private timer: ReturnType<typeof setInterval> | undefined
  constructor(private readonly ctx: Context, private readonly engine: SeatEngine) {}
  /** Restore queued inputs only; interrupted admitted work is never blindly replayed. */
  async start(): Promise<void> {
    const recovered = [...this.engine.journal.projection.children.values()]
    const restored = new Set<ChildTicketId>()
    const restore = () => {
      for (const ticket of recovered) {
        const current = this.engine.journal.projection.children.get(ticket.ticketId)
        if (ticket.phase !== 'queued' || !ticket.activation || restored.has(ticket.ticketId)
          || !current || !['queued', 'admitted'].includes(current.phase)) continue
        const parent = this.ctx.get('agents')?.get(ticket.parentSessionId)
        if (!parent) continue
        const frozen: unknown = ticket.activation
        if (!frozen || typeof frozen !== 'object' || !('provider' in frozen) || typeof frozen.provider !== 'string'
          || !('label' in frozen) || typeof frozen.label !== 'string' || !('delivery' in frozen)
          || !['caller', 'parent'].includes(String(frozen.delivery)) || !('request' in frozen)
          || !frozen.request || typeof frozen.request !== 'object' || !('prompt' in frozen.request)
          || !Array.isArray(frozen.request.prompt)) throw new EngineError('engine-store-corrupt', 'Invalid queued activation')
        const activation = frozen as FrozenActivation
        restored.add(ticket.ticketId)
        this.queued.set(ticket.ticketId, { ...activation, request: { ...activation.request, parent },
          signal: new AbortController().signal })
      }
      void this.drain().catch((error: unknown) => { this.ctx.logger.warn('Child FIFO recovery failed', error) })
    }
    restore()
    this.timer = setInterval(restore, this.engine.options.config.ownerObserveIntervalMs)
    this.timer.unref()
    await this.drain()
  }
  private async definition(parent: Agent): Promise<SeatDefinition | undefined> {
    const open = this.engine.journal.projection.opens.get(parent.id)
    if (open?.definition) return open.definition
    const seats = this.ctx.get('seats')
    const binding = await this.ctx.get('seatLocalRead')?.binding({ sessionId: parent.id })
    if (!binding || 'status' in binding || binding.kind !== 'seat') return undefined
    const definition = await seats?.resolve(binding.seat)
    return definition && !('status' in definition) ? definition : undefined
  }
  async acquire(spec: SubagentActivationSpec) {
    if (this.stopped) throw new EngineError('unavailable', 'Child admission is stopping')
    const grant = this.grants.get(spec)
    if (grant) { this.grants.delete(spec); return this.reservation(grant) }
    const definition = await this.definition(spec.request.parent)
    if (!definition) return { status: 'reserved' as const, release: async () => {} }
    const { parent: _parent, ...request } = spec.request
    const frozen: FrozenActivation = { provider: spec.provider, label: spec.label, delivery: spec.delivery, request,
      ...(spec.childId ? { childId: spec.childId } : {}) }
    const activation = JSON.parse(canonical(frozen)) as SeatJson
    const result = await this.engine.admitChild({ maxActive: definition.maxActiveSubagents,
      ticket: { ticketId: randomUUID() as ChildTicketId, parentSessionId: spec.request.parent.id, sequence: 0,
        requestDigest: digest(activation), agentPreset: request.agentPreset ?? definition.agentPreset,
        permissionRevision: definition.revision, activation, phase: 'queued', childSessionId: null,
        ownerEpoch: randomUUID() as OwnerEpoch, stateVersion: 0 } })
    if (result.status === 'rejected') throw new EngineError(result.error.code, result.error.message)
    if (result.status === 'queued') {
      this.queued.set(result.ticket.ticketId, spec)
      return { status: 'queued' as const, ticketId: result.ticket.ticketId, parentSessionId: spec.request.parent.id }
    }
    return this.reservation(result.ticket)
  }
  private reservation(ticket: ChildAdmissionTicket): SubagentReservation {
    return { status: 'reserved', release: async (childId) => {
      if (childId) await this.engine.journal.commit((view) => {
        const current = view.children.get(ticket.ticketId)
        return current?.phase === 'admitted' && current.childSessionId !== childId
          ? [fact({ kind: 'child/admitted', data: { ...current, childSessionId: childId, stateVersion: current.stateVersion + 1 } })] : []
      })
      await this.engine.releaseChild(ticket.ticketId)
      if (!this.active) await this.drain()
    } }
  }
  async continue(parent: Agent, childId: SessionId): Promise<void> {
    const definition = await this.definition(parent)
    if (!definition) return
    const ledger = await this.ctx.get('sessionLedger')?.query({ sessionId: childId })
    const call = ledger?.rows.findLast(row => row.kind === 'call' && row.start.purpose === 'conversation' && row.finish)
    const cache = call?.kind === 'call' ? call.finish?.cache ?? call.start.cache : undefined
    const usage = call?.kind === 'call' ? call.finish?.usage : undefined
    const tokens = [usage?.inputTokens, usage?.cacheReadTokens, usage?.cacheWriteTokens]
    if (!ledger?.complete || cache?.lastCacheEvidenceAt === undefined || cache.ttlSeconds === undefined
      || !cache.prefixFingerprint || tokens.some(value => value === undefined || !Number.isFinite(value) || value < 0)) {
      throw new EngineError('evidence-unavailable', 'Child evidence is unavailable; start a new subagent')
    }
    if (Date.now() - cache.lastCacheEvidenceAt > cache.ttlSeconds * 1000) {
      throw new EngineError('subagent-renewal-expired', 'Child cache expired; start a new subagent')
    }
    if (tokens.reduce<number>((sum, value) => sum + (value ?? 0), 0) >= definition.subagentContextThresholdTokens) {
      throw new EngineError('subagent-context-limit', 'Child context reached its limit; start a new subagent')
    }
  }
  async resume(parent: Agent, childId: SessionId) {
    await this.continue(parent, childId)
    const retained = [...this.engine.journal.projection.children.values()].find(ticket => ticket.parentSessionId === parent.id
      && (ticket.phase === 'queued' || ticket.phase === 'admitted') && ticket.activation !== null
      && typeof ticket.activation === 'object' && 'childId' in ticket.activation && ticket.activation.childId === childId)
    if (retained) return retained.phase === 'admitted' ? this.reservation(retained)
      : { status: 'queued' as const, ticketId: retained.ticketId, parentSessionId: parent.id }
    return this.acquire({ provider: 'resume', label: childId, childId, request: { parent, prompt: [] },
      signal: new AbortController().signal, delivery: 'parent' })
  }
  /** Join FIFO replay after releases; queued starts always re-enter the real manager. */
  drain(): Promise<void> {
    if (this.active) return this.active
    this.active = this.run().finally(() => { this.active = undefined })
    return this.active
  }
  private async run(): Promise<void> {
    if (this.stopped) return
    const runtime = this.ctx.get('subagents')
    if (!runtime) return
    for (const ticket of this.engine.journal.projection.children.values()) {
      if (ticket.phase !== 'admitted') continue
      const spec = this.queued.get(ticket.ticketId)
      if (!spec) continue
      if (spec.provider === 'resume') continue
      this.queued.delete(ticket.ticketId)
      this.grants.set(spec, ticket)
      try { await runtime.startActivation(spec) }
      catch (error) {
        this.grants.delete(spec)
        this.ctx.logger.warn('Queued child activation failed', error)
      }
    }
  }
  /** Stop dispatching before the engine releases its writer lock. */
  async close(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.active }
}
