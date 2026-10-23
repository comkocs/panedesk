/** Traditional creation uses explicit choices and durable identity beside Session data. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import type { CreateAgentOptions } from '@panedesk/dsh-agent'
import type { LedgerRunId } from '@panedesk/dsh-session-ledger'
import type * as T from '@panedesk/dsh-seat'
import type { SeatStore } from './store.ts'
import type { LocalSeatService } from './service.ts'
import { DirectoryAdmission } from './directory-admission.ts'
import { canonicalPath } from './identity.ts'
import { localFact } from './engine-state.ts'
import { openingContext, openingGate } from './open-gates.ts'

/** Trusted adapters scope one confirmed traditional creation, never wire-provided identity. */
export interface LocalSeatCreation {
  /** Retain a single-use choice for the authenticated caller.
   * @param cwd - requested directory.
   * @param authority - adapter-authenticated caller.
   * @returns one-use traditional confirmation.
   */
  confirmTraditional(cwd: string, authority: T.SeatCallContext): Promise<T.DirectoryConfirmation>
  /** Execute a traditional create using a previously confirmed choice.
   * @param confirmation - retained single-use capability.
   * @param authority - authenticated adapter caller.
   * @param create - upstream creation operation.
   * @returns upstream result unchanged.
   */
  run<R>(confirmation: T.DirectoryConfirmation, authority: T.SeatCallContext, create: () => Promise<R>): Promise<R>
}
declare module '@panedesk/cordis' {
  interface Context { seatLocalCreation: LocalSeatCreation }
}

/** Structured choice error survives direct Agent and controller creation without guessing a seat. */
export class SeatDirectoryChoiceError extends Error {
  constructor(readonly result: Exclude<T.DirectoryChoiceResult, { status: 'allowed' }>) {
    super(JSON.stringify(result))
    this.name = 'SeatDirectoryChoiceError'
  }
}

/** Register the pre-factory consumer and its lifetime-owned confirmations.
 * @param ctx - local plugin owner.
 * @param service - durable local state owner.
 * @param store - complete catalog owner.
 */
export function installCreateAdmission(ctx: Context, service: LocalSeatService, store: SeatStore): void {
  const choices = new DirectoryAdmission(service.options.maxConfirmations)
  const scope = new AsyncLocalStorage<{
    confirmation: T.DirectoryConfirmation
    authority: T.SeatCallContext
    releases: Set<() => void>
  }>()
  let active = true
  const preparations = new Map<CreateAgentOptions['sessionId'], () => void>()
  ctx.provide('seatLocalCreation', {
    confirmTraditional: async (cwd, authority) => {
      if (!active || authority.nodeId !== service.options.nodeId) throw new Error('Traditional creation is unavailable for this node')
      return choices.confirm(cwd, authority.principalId, store.snapshot().definitions, { kind: 'traditional' })
    },
    run: async (confirmation, authority, create) => {
      if (!active || authority.nodeId !== service.options.nodeId) throw new Error('Traditional creation is unavailable for this node')
      const releases = new Set<() => void>()
      try { return await scope.run({ confirmation, authority, releases }, create) }
      finally { for (const release of releases) release() }
    },
  })
  ctx.effect(() => () => {
    active = false
    choices.dispose(); scope.disable()
    for (const release of preparations.values()) release()
    preparations.clear()
  })
  ctx.on('agent/create-admitting', async ({ options }, next) => {
    const upstream = await next()
    if (upstream.kind !== 'allow') return upstream
    const engine = ctx.get('seatEngine')
    if (!engine) return { kind: 'reject', reason: 'Seat identity storage is unavailable. Restore the seat engine before creating.' }
    const facts = (await service.state.read()).effects
    const intent = facts.findLast(effect => effect.kind === 'open/intent' && effect.data.sessionId === options.sessionId)
    const cwd = options.meta?.cwd ?? process.cwd()
    const controlled = intent?.kind === 'open/intent' && intent.data.binding.kind === 'seat'
      && intent.data.definition?.directories.some(directory => directory.startup && directory.path === cwd)
    const child = facts.findLast(effect => (effect.kind === 'child/admitted' || effect.kind === 'child/released')
      && effect.data.childSessionId === options.sessionId)
    const parentId = options.parentAgent?.id ?? (child?.kind === 'child/admitted' ? child.data.parentSessionId : undefined)
    const parent = parentId === undefined ? undefined : facts.findLast(effect => (effect.kind === 'seat/binding'
      || effect.kind === 'open/created' || effect.kind === 'open/configured') && effect.data.sessionId === parentId)
    const binding = parent?.kind === 'seat/binding' ? parent.data
      : parent?.kind === 'open/created' || parent?.kind === 'open/configured' ? parent.data.binding : undefined
    const inherited = binding?.kind === 'seat' ? binding.seat : undefined
    const retained = scope.getStore()
    const principal = retained?.authority.principalId ?? 'traditional-create' as T.SeatPrincipalId
    const selection = controlled ? { status: 'allowed' as const, identity: 'seat' as const }
      : await choices.resolve({ cwd, interactive: false, ...(inherited === undefined ? {} : { seat: inherited }),
        ...(retained === undefined ? {} : { confirmation: retained.confirmation }) }, principal, store.snapshot().definitions)
    if (selection.status !== 'allowed') throw new SeatDirectoryChoiceError(selection)
    const operationId = `traditional:${options.sessionId}` as T.SeatOperationId
    const seat = selection.identity === 'free' ? null
      : controlled && intent.data.binding.kind === 'seat' ? intent.data.binding.seat : inherited ?? null
    const gate = await openingGate(ctx, { ...openingContext(service.options.nodeId, operationId, seat),
      sessionId: options.sessionId, hook: 'before-open', cwd: await canonicalPath(cwd),
      candidateSeats: selection.identity === 'free' ? [] : seat === null ? [] : [seat] })
    if (gate) return { kind: 'reject', reason: `${gate.error.message} ${gate.error.alternative}` }
    if (controlled || (inherited !== undefined && selection.identity === 'seat')) return upstream
    preparations.get(options.sessionId)?.()
    const ledger = ctx.get('sessionLedger')
    const unbind = ledger?.bindContext({ sessionId: options.sessionId, rootSessionId: options.sessionId,
      runId: randomUUID() as LedgerRunId, nodeId: service.options.nodeId, seat: 'free', window: 'free',
      identitySource: 'free', accountLabel: 'unknown' })
    const release = () => {
      unbind?.()
      preparations.delete(options.sessionId)
      retained?.releases.delete(release)
    }
    preparations.set(options.sessionId, release)
    retained?.releases.add(release)
    return upstream
  })
  ctx.on('agent/created', async ({ agent, source }) => {
    if (source !== 'startup' || !preparations.has(agent.id)) return
    try {
      await service.state.mutate(effects => ({ result: undefined,
        effects: effects.some(effect => effect.kind === 'seat/binding' && effect.data.sessionId === agent.id) ? []
          : [localFact({ kind: 'seat/binding', sessionId: agent.id,
            data: { kind: 'free', sessionId: agent.id, nodeId: service.options.nodeId, identitySource: 'free' } })] }))
    } finally { preparations.get(agent.id)?.(); preparations.delete(agent.id) }
  })
}
