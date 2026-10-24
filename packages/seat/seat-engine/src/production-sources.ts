/** Configured production observers all enter the engine's durable trigger queue. */
import { join } from 'node:path'
import type { Context } from '@panedesk/cordis'
import { decodeScheduleRecord, isRecurringScheduleRecord, resolveRecurringOccurrence, type ScheduleRecord } from '@panedesk/dsh-schedule'
import type { SeatName, SeatProjectId, SeatSourceId, SeatTriggerEvidence, SourceEventId, TriggerId, SeatOperationId } from '@panedesk/dsh-seat'
import type {} from '@panedesk/dsh-message-delivery'
import { GitTrigger } from './git-trigger.ts'
import { canonical, digest, EngineError } from './journal.ts'
import type { SeatEngine } from './engine.ts'

/** Explicit observer destinations; repository paths never come from untrusted trigger data. */
export interface ProductionSource {
  /** Stable ingress identity, unique among configured sources; required with no default. */
  sourceId: SeatSourceId
  /** Destination seat for accepted triggers; required with no default. */
  seat: SeatName
  /** Project identity attached to accepted triggers; required with no default. */
  projectId: SeatProjectId
  /** Trusted observer policy; required with no default or inferred trigger kind. */
  trigger: {
    /** Selects durable scheduled actions; required with no default. */
    kind: 'schedule'
    /** Schedule identity and timing registered for the seat.open action; required with no default. */
    record: ScheduleRecord
  } | {
    /** Selects read-only Git ref observation; required with no default. */
    kind: 'git'
    /** Trusted local repository directory used for Git commands; required with no default. */
    repository: string
    /** Stable repository identity in trigger evidence and checkpoints; required with no default. */
    repositoryId: string
    /** Fully qualified ref beginning with refs/ to observe; required with no default. */
    ref: string
    /** Fallback observation interval in positive integer milliseconds; required with no default. */
    fallbackMs: number
  } | {
    /** Selects durable window closure or close-report observation; required with no default. */
    kind: 'window-ended'
    /** Source seat whose windows are observed, distinct from the destination; required with no default. */
    seat: SeatName
    /** Whether closure or a report permitting closure triggers ingress; required with no default. */
    on: 'closed' | 'can-close'
  } | {
    /** Selects unanswered handoffs from the destination seat; required with no default. */
    kind: 'handoff-timeout'
    /** Positive unanswered age threshold in minutes, including fractions; required with no default. */
    timeoutMinutes: number
  }
}

function normalizedRecord(record: ScheduleRecord): string {
  return canonical('timeZone' in record
    ? { ...record, timeZone: new Intl.DateTimeFormat('en-US', { timeZone: record.timeZone }).resolvedOptions().timeZone }
    : record)
}

/** Register observers under the Loader owner, with recovery through stable event identities.
 * @param ctx - plugin lifetime.
 * @param engine - ready journal owner.
 * @param sources - explicit configured source policies; an empty list removes obsolete owned schedule actions.
 * @returns disposer that joins all observer work before the journal closes.
 */
export function registerProductionSources(ctx: Context, engine: SeatEngine, sources: readonly ProductionSource[]): () => Promise<void> {
  const owner = ctx.plugin({ name: 'seat-production-sources', apply(child: Context) { install(child, engine, sources) } })
  return async () => { await owner.dispose() }
}

function install(ctx: Context, engine: SeatEngine, sources: readonly ProductionSource[]): void {
  for (const source of sources) ctx.effect(() => engine.registerSource({ sourceId: source.sourceId,
    kinds: [source.trigger.kind], maxRedeliveryMs: null, callback: async () => {} }))
  const accept = async (source: ProductionSource, evidence: SeatTriggerEvidence, identity: string) => {
    const eventId = digest([source.sourceId, identity]) as string as SourceEventId
    return engine.accept({ triggerId: eventId as string as TriggerId, sourceId: source.sourceId, eventId,
      kind: evidence.kind, evidence, seat: source.seat, projectId: source.projectId,
      receivedAt: new Date().toISOString(), data: null, dataDigest: digest(null), callbackRef: source.sourceId })
  }
  ctx.inject(['schedule'], (owner) => {
    const schedule = owner.get('schedule')
    if (!schedule) return
    const register = () => schedule.registerAction('seat.open', async (request) => {
      const source = sources.find(item => item.trigger.kind === 'schedule' && item.trigger.record.id === request.record.id)
      if (!source) throw new EngineError('source-not-found', 'Scheduled seat source is unavailable')
      const result = await accept(source, { kind: 'schedule', scheduleId: request.record.id,
        scheduledAt: request.scheduledAt }, request.eventId)
      if (result.status === 'rejected') {
        if (result.error.code === 'disabled') return { status: 'skipped-disabled' }
        throw new EngineError(result.error.code, result.error.message)
      }
      return { status: 'accepted' }
    })
    owner.effect(() => {
      const lifetime = new AbortController()
      let unregister: (() => Promise<void>) | undefined
      const starting = (async () => {
        const existing = await schedule.listActions()
        const sourceIds = new Set<string>(sources.map(source => source.sourceId))
        const removed = new Set<string>()
        for (const item of existing) {
          if (lifetime.signal.aborted) return
          const payload = item.payload
          if (item.actionId !== 'seat.open' || !payload || typeof payload !== 'object' || Array.isArray(payload)
            || typeof payload['sourceId'] !== 'string' || sourceIds.has(payload['sourceId'])) continue
          await schedule.deleteAction(item.record.id)
          removed.add(item.record.id)
          owner.logger.info('Seat schedule source removed', { scheduleId: item.record.id, sourceId: payload['sourceId'] })
        }
        for (const source of sources) {
          if (source.trigger.kind !== 'schedule') continue
          if (lifetime.signal.aborted) return
          const record = decodeScheduleRecord(source.trigger.record)
          const previous = existing.find(item => item.record.id === record.id)
          if (previous && previous.actionId !== 'seat.open') continue
          if (previous && !removed.has(record.id)) {
            // Recurring dispatch advances scheduledAt; compare the configured anchor at the last receipt.
            const expected = isRecurringScheduleRecord(record) && previous.lastReceipt
              && previous.record.kind === record.kind && record.scheduledAt <= previous.lastReceipt.scheduledAt
              ? { ...record, scheduledAt: resolveRecurringOccurrence(record,
                Date.parse(previous.lastReceipt.scheduledAt)).nextScheduledAt ?? previous.lastReceipt.scheduledAt }
              : record
            if (normalizedRecord(previous.record) === normalizedRecord(expected)
              && canonical(previous.payload) === canonical({ sourceId: source.sourceId })) continue
            await schedule.deleteAction(record.id)
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- Disposal can abort while deletion is awaited.
            if (lifetime.signal.aborted) return
          }
          await schedule.scheduleAction({ record, actionId: 'seat.open', payload: { sourceId: source.sourceId } })
          if (previous) owner.logger.info('Seat schedule source reconciled', { scheduleId: record.id, sourceId: source.sourceId })
        }
        if (!lifetime.signal.aborted) unregister = register()
      })().catch((error: unknown) => { owner.logger.warn('Seat schedule registration failed', error) })
      return async () => { lifetime.abort(); await starting; await unregister?.() }
    })
  })
  for (const source of sources) {
    if (source.trigger.kind !== 'git') continue
    const trigger = source.trigger
    ctx.effect(() => {
      const observer = new GitTrigger({ ...trigger, repositoryId: trigger.repositoryId as Extract<SeatTriggerEvidence, { kind: 'git' }>['repositoryId'],
        checkpoint: join(engine.journal.root, `git-${digest([trigger.repositoryId, trigger.ref])}.json`), journal: engine.journal,
        accept: evidence => accept(source, evidence, `${evidence.observationSequence}:${evidence.newObjectId}`),
        onError: (error) => { ctx.logger.warn('Seat Git observation failed', error) } })
      const starting = observer.start()
      void starting.catch((error: unknown) => { ctx.logger.warn('Seat Git source startup failed', error) })
      return async () => { try { await starting } finally { await observer.stop() } }
    })
  }
  ctx.effect(() => {
    let stopped = false, active: Promise<void> | undefined
    const seen = new Set<string>()
    const scan = async () => {
      for (const source of sources) {
        if (source.trigger.kind === 'window-ended') {
          for (const decision of [...engine.journal.projection.decisions]) for (const effect of decision.effects) {
            const closed = effect.kind === 'window/closed' && source.trigger.on === 'closed' ? effect.data : undefined
            const report = effect.kind === 'report/submitted' && source.trigger.on === 'can-close' ? effect.data.report : undefined
            if ((!closed && !report?.canClose) || seen.has(`${source.sourceId}:${effect.eventId}`)) continue
            const sessionId = closed?.sessionId ?? report?.sessionId
            if (!sessionId) continue
            const open = engine.journal.projection.opens.get(sessionId)
            if (open?.binding.kind !== 'seat' || open.binding.seat !== source.trigger.seat) continue
            const result = await accept(source, { kind: 'window-ended', sessionId, endedEventId: effect.eventId as string as SourceEventId,
              reportId: report?.reportId ?? null, origin: source.trigger.on }, effect.eventId)
            if (result.status !== 'rejected' || result.error.code === 'disabled') seen.add(`${source.sourceId}:${effect.eventId}`)
          }
        }
        if (source.trigger.kind === 'handoff-timeout') {
          const delivery = ctx.get('messageDelivery')
          if (!delivery) continue
          let cursor: import('@panedesk/dsh-message-delivery').MessageCursor | undefined
          do {
            const page = await delivery.list({ messageClasses: ['handoff'], states: ['queued', 'injected'],
              unansweredOlderThanMinutes: source.trigger.timeoutMinutes, ...(cursor ? { cursor } : {}) })
            for (const message of page.items) {
              const first = message.transitions[0]?.data
              if (!first?.senderSessionId || seen.has(`${source.sourceId}:${message.messageId}`)) continue
              const open = engine.journal.projection.opens.get(first.senderSessionId)
              if (open?.binding.kind !== 'seat' || open.binding.seat !== source.seat) continue
              const result = await accept(source, { kind: 'handoff-timeout', messageId: message.messageId,
                senderSessionId: first.senderSessionId, deadlineVersion: first.stateVersion,
                deadlineAt: new Date(first.observedAt + source.trigger.timeoutMinutes * 60000).toISOString(),
                timeoutMinutes: source.trigger.timeoutMinutes,
                wakeOperationId: digest([source.sourceId, message.messageId]) as string as SeatOperationId }, message.messageId)
              if (result.status !== 'rejected' || result.error.code === 'disabled') seen.add(`${source.sourceId}:${message.messageId}`)
            }
            cursor = page.nextCursor
          } while (cursor && !stopped)
        }
      }
    }
    const request = () => {
      if (stopped || active) return
      active = scan().catch((error: unknown) => { ctx.logger.warn('Seat source observation failed', error) })
        .finally(() => { active = undefined })
    }
    const timer = setInterval(request, engine.options.config.ownerObserveIntervalMs)
    timer.unref()
    const off = ctx.on('seat/decision', () => { request() })
    request()
    return async () => { stopped = true; clearInterval(timer); off(); await active }
  })
}
