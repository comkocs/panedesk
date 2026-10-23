/** Wait projections and terminal wake receipts share the engine journal and operation identities. */
import type * as T from '@panedesk/dsh-seat'
import { LocalEngineState, localFact } from './engine-state.ts'
import { digest } from './store.ts'
import { rejected } from './errors.ts'

/** Fold the latest durable version of each registration.
 * @param effects - complete ordered engine facts.
 * @returns waits keyed by their stable identity.
 */
export function projectedWaits(effects: readonly T.EngineEffect[]): Map<T.WaitId, T.SeatWait> {
  const waits = new Map<T.WaitId, T.SeatWait>()
  for (const effect of effects) {
    if (effect.kind === 'wait/registered' || effect.kind === 'wait/satisfied'
      || effect.kind === 'wait/woken' || effect.kind === 'wait/cancelled') waits.set(effect.data.waitId, effect.data)
  }
  return waits
}

/** Observation writes preserve object ownership and never manufacture successful unknown outcomes. */
export class WaitStore {
  constructor(private readonly state: LocalEngineState) {}

  /** Read one durable registration without observing or waking it.
   * @param waitId - stable identity.
   * @returns committed state, or null.
   */
  async read(waitId: T.WaitId): Promise<T.SeatWait | null> {
    return projectedWaits((await this.state.read()).effects).get(waitId) ?? null
  }

  /** Persist registration before checking task snapshots.
   * @param request - authenticated and authorized objects.
   * @returns original registration on replay, or conflict.
   */
  register(request: T.RegisterSeatWaitRequest): Promise<T.SeatWait | T.SeatRejected> {
    return this.state.mutate<T.SeatWait | T.SeatRejected>((effects) => {
      const previous = projectedWaits(effects).get(request.waitId)
      if (previous !== undefined) return { effects: [], result: previous.sessionId === request.sessionId
        && previous.operationId === request.operationId && previous.mode === request.mode
        && digest(previous.objects) === digest(request.objects) ? previous
        : rejected('wait-id-conflict', 'The wait identity has different contents.', 'Retain the original registration.') }
      if (effects.some(effect => effect.operationId === request.operationId)) return { effects: [],
        result: rejected('operation-id-conflict', 'The operation already owns another fact.', 'Use the original operation request.') }
      const wait: T.SeatWait = { ...request, objects: structuredClone(request.objects), observations: [], phase: 'registered',
        wakeOperationId: `${request.operationId}:wake` as T.SeatOperationId, stateVersion: 1, durability: 'durable' }
      return { result: wait, effects: [localFact({ kind: 'wait/registered', sessionId: request.sessionId,
        operationId: request.operationId, data: wait })] }
    })
  }

  /** Commit newer observations; only terminal non-unknown outcomes satisfy a wait.
   * @param waitId - registration being observed.
   * @param observation - provider-owned dated evidence.
   * @returns committed registration state.
   */
  observe(waitId: T.WaitId, observation: T.WaitObservation): Promise<T.SeatWait> {
    return this.state.mutate((effects) => {
      const wait = projectedWaits(effects).get(waitId)
      if (wait === undefined) throw new Error('Wait registration is missing')
      if (wait.phase !== 'registered' || !wait.objects.some(object => digest(object) === digest(observation.object))) {
        return { result: wait, effects: [] }
      }
      const key = digest(observation.object)
      const prior = wait.observations.find(item => digest(item.object) === key)
      if (prior !== undefined && prior.watermark >= observation.watermark) return { result: wait, effects: [] }
      const observations = [...wait.observations.filter(item => digest(item.object) !== key), observation]
      const terminal = observations.filter(item => item.outcome !== 'unknown').length
      const satisfied = wait.mode === 'any' ? terminal > 0 : terminal === wait.objects.length
      const next: T.SeatWait = { ...wait, observations, phase: satisfied ? 'satisfied' : 'registered',
        stateVersion: wait.stateVersion + 1,
        durability: observations.some(item => item.durability === 'best-effort') ? 'best-effort' : 'durable' }
      return { result: next, effects: [localFact({ kind: satisfied ? 'wait/satisfied' : 'wait/registered',
        sessionId: wait.sessionId, data: next })] }
    })
  }

  /** Cancel observation without cancelling tasks; satisfaction wins once committed.
   * @param request - expected version and authenticated owner.
   * @returns cancelled or already settled registration.
   */
  cancel(request: T.CancelSeatWaitRequest): Promise<T.CancelSeatWaitResult> {
    return this.state.mutate<T.CancelSeatWaitResult>((effects) => {
      const wait = projectedWaits(effects).get(request.waitId)
      if (wait === undefined || wait.sessionId !== request.sessionId) return { effects: [],
        result: rejected('wait-object-not-found', 'Wait is not owned by this session.', 'Select an owned registration.') }
      if (wait.phase !== 'registered') return { effects: [], result: { status: 'already-settled', wait } }
      if (wait.stateVersion !== request.expectedStateVersion) return { effects: [],
        result: rejected('state-conflict', 'Wait observations changed.', 'Read the current wait version.') }
      const next: T.SeatWait = { ...wait, phase: 'cancelled', stateVersion: wait.stateVersion + 1 }
      return { result: { status: 'cancelled', wait: next }, effects: [localFact({ kind: 'wait/cancelled',
        sessionId: wait.sessionId, operationId: request.operationId, data: next })] }
    })
  }

  /** Mark successful durable M5 delivery; retries keep the original wake identity.
   * @param waitId - satisfied registration.
   * @returns after the receipt commits.
   */
  async woken(waitId: T.WaitId): Promise<void> {
    await this.state.mutate((effects) => {
      const wait = projectedWaits(effects).get(waitId)
      return { result: undefined, effects: wait?.phase === 'satisfied' ? [localFact({ kind: 'wait/woken',
        sessionId: wait.sessionId, operationId: wait.wakeOperationId,
        data: { ...wait, phase: 'woken', stateVersion: wait.stateVersion + 1 } })] : [] }
    })
  }
}
