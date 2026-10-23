/** Observation adapters read durable task facts and use events only to invalidate snapshots. */
import type { Context } from '@panedesk/cordis'
import type { WaitObject, WaitObservation } from '@panedesk/dsh-seat'
import type { LocalEngineState } from './engine-state.ts'
import type {} from '@panedesk/dsh-schedule'
import type {} from '@panedesk/dsh-subagent'
import type {} from '@panedesk/dsh-jobs'
import type {} from '@panedesk/dsh-message-delivery'
import type { LocalSeatRuntime } from './service-options.ts'
import { rejected } from './errors.ts'

/** Build task snapshot and registration capabilities without polling model turns.
 * @param ctx - owner of all installed subscriptions.
 * @returns authorized observations with awaited per-wait disposal.
 */
export function createWaitObservation(ctx: Context, state: LocalEngineState): Pick<LocalSeatRuntime, 'authorizeWait' | 'snapshot' | 'subscribe'> {
  const snapshot = async (object: WaitObject): Promise<WaitObservation | null> => {
    const observedAt = new Date().toISOString()
    if (object.kind === 'message') {
      const status = await ctx.get('messageDelivery')?.status(object.id)
      if (status === undefined || !['responded', 'withdrawn', 'invalidated', 'rejected'].includes(status.state)) return null
      return { object, observedAt, watermark: status.stateVersion, durability: 'durable',
        outcome: status.state === 'responded' ? 'completed' : status.state === 'rejected' ? 'failed' : 'cancelled' }
    }
    const query = ctx.get('sessionQuery')
    if (object.kind === 'schedule') {
      const task = (await ctx.get('schedule')?.catalog())?.find(item => item.id === object.id)
      if (task?.lastDelivery !== undefined) {
        const saved = await query?.readSession(task.sessionId)
        const messageId = task.lastDelivery.messageId
        let turn: number | undefined
        let consumedTurn: number | undefined
        const queues = new Map<string, string[]>()
        const stepped = new Set<number>()
        for (const event of saved?.events ?? []) {
          if (event.type === 'turn/start') turn = event.data.turn
          if (event.type === 'step/start') stepped.add(event.data.turn)
          if (event.type === 'agent/inbox/spliced') {
            const queue = queues.get(event.data.target) ?? []
            const removed = queue.splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted.map(item => item.id))
            queues.set(event.data.target, queue)
            if (removed.includes(messageId)) {
              if (event.data.outcome === 'canceled') return { object, observedAt, watermark: event.seq,
                durability: 'durable', outcome: 'cancelled' }
              consumedTurn = turn
            }
          }
          if (event.type === 'turn/end' && event.data.turn === consumedTurn) {
            if (event.data.reason.kind === 'completed' && !stepped.has(event.data.turn)) continue
            return { object, observedAt, watermark: event.seq, durability: 'durable',
              outcome: event.data.reason.kind === 'completed' ? 'completed' : event.data.reason.kind === 'aborted' ? 'cancelled' : 'failed' }
          }
        }
      }
    }
    for (const session of await query?.listSessions() ?? []) {
      const saved = await query?.readSession(session.header.id)
      for (const event of [...saved?.events ?? []].reverse()) {
        if (object.kind === 'job' && event.type === 'job/settled' && event.data.jobId === object.id) {
          return { object, observedAt, watermark: event.seq, durability: 'durable',
            outcome: event.data.status === 'completed' ? 'completed' : event.data.status === 'killed' ? 'cancelled' : 'failed' }
        }
        if (object.kind === 'schedule' && event.type === 'schedule/change' && event.data.operation === 'delete'
          && event.data.id === object.id) return { object, observedAt, watermark: event.seq, durability: 'durable', outcome: 'cancelled' }
      }
    }
    if (object.kind === 'subagent') {
      const facts = (await state.read()).effects
      const terminal = facts.findLast(effect => effect.kind === 'job/observed' && effect.data.phase === 'settled'
        && effect.data.observation.object.kind === 'subagent' && effect.data.observation.object.id === object.id)
      if (terminal?.kind === 'job/observed') return terminal.data.observation
    }
    return null
  }
  return { snapshot,
    authorizeWait: async (request) => {
      const session = ctx.get('sessions')?.get(request.sessionId)
      if (session === undefined) return rejected('wait-object-unauthorized', 'The waiting session is unavailable.', 'Resume its local owner.')
      for (const object of request.objects) {
        let owned = false
        if (object.kind === 'job') owned = ctx.get('jobs')?.list(request.sessionId).some(job => job.id === object.id && job.owner === request.sessionId) ?? false
        if (object.kind === 'schedule') owned = (await ctx.get('schedule')?.catalog())?.some(item => item.id === object.id && item.sessionId === request.sessionId) ?? false
        if (object.kind === 'subagent') owned = (await state.read()).effects.some(effect => effect.kind === 'job/observed'
          && effect.data.sessionId === request.sessionId && effect.data.observation.object.kind === 'subagent'
          && effect.data.observation.object.id === object.id)
        if (object.kind === 'message') {
          const status = await ctx.get('messageDelivery')?.status(object.id)
          owned = status?.transitions.some(item => item.data.senderSessionId === request.sessionId
            || item.data.targetSessionId === request.sessionId) ?? false
        }
        if (!owned) return rejected('wait-object-unauthorized', 'A wait object is not owned by this session.', 'Select an owned task or message.')
      }
      return null
    },
    subscribe: (object, listener) => {
      const lifecycle = new AbortController()
      let tail = Promise.resolve()
      const active = () => !lifecycle.signal.aborted
      const changed = () => {
        tail = tail.then(async () => {
          if (lifecycle.signal.aborted) return
          const observation = await snapshot(object)
          if (active() && observation !== null) await listener(observation)
        })
        return tail
      }
      const invalidated = () => {
        tail = changed().catch((error: unknown) => { ctx.logger.warn('seat wait observation failed', error) })
      }
      const off = ctx.on('session/event', invalidated)
      const message = ctx.on('message/state', invalidated)
      const decision = ctx.on('seat/decision', invalidated)
      return () => { lifecycle.abort(); off(); message(); decision(); return Promise.resolve() }
    } }
}
