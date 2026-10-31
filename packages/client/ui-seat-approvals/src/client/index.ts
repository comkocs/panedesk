/** Mount the opt-in approval namespace and its additive frame surface. */
import type { Context } from '@panedesk/cordis'
import contribution from '@panedesk/dsh-client-ui-seat-approvals/remote'
import type {} from '@panedesk/dsh-api-gateway/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-resources/client'
import type {} from '@panedesk/dsh-client-ui-layout/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import { randomUUID } from '@panedesk/dsh-util-crypto'
import { RemoteError, remoteErrorOf } from '@panedesk/dsh-typert-protocol'
import type { RemoteResult } from '@panedesk/dsh-typert-protocol'
import type * as Seat from '@panedesk/dsh-seat'
import type { ApprovalQueueView } from '../types.ts'
import { ApprovalPanel } from './panel.tsx'
import { ApprovalObservations } from './observations.ts'
import { en, zh, type ApprovalKey } from './locales.ts'

/** Plain business actions injected into the approval panel. */
export interface ApprovalActions {
  mutate(this: void, item: Seat.PendingSeatItem, action: 'approve' | 'cancel'): Promise<{ operationId: Seat.SeatOperationId; result: RemoteResult<Seat.PendingSeatMutationResult> }>
}

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { seatApprovals: ApprovalKey }
  interface ResourceProtocolMap {
    'seat-approvals': ApprovalQueueView
    'seat-approval-operation': Seat.SeatEngineOperationResult
  }
}

/** Services used to load generated Remote methods and publish resource observations. */
export const inject = ['remote', 'slots', 'locale', 'resources']

/** Install an additive top-right surface without replacing an occupied header slot.
 * @param ctx - Client plugin lifetime.
 * @returns Remote mount and UI disposal owned by Cordis effects.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.seatApprovals'], (scope) => {
    const observations = new ApprovalObservations()
    scope.effect(() => scope.locale.register('seatApprovals', { zh, en }), 'seat-approvals: locale')
    scope.effect(() => scope.resources.register<'seat-approvals'>({
      protocol: 'seat-approvals',
      async *open(_address, { signal }): AsyncIterable<RemoteResult<ApprovalQueueView>> {
        try {
          for await (const value of scope.remote.seatApprovals.watchPending(signal)) yield { ok: true, value: observations.observe(value) }
        } catch (error) {
          if (!signal.aborted) yield { ok: false, error: remoteErrorOf(error)
            ?? new RemoteError('seat-approvals/unavailable', 'Approval observation unavailable', {}) }
        }
      },
    }), 'seat-approvals: pending resource')
    scope.effect(() => scope.resources.register<'seat-approval-operation'>({
      protocol: 'seat-approval-operation',
      async *open(address, { signal }): AsyncIterable<RemoteResult<Seat.SeatEngineOperationResult>> {
        const operationId = decodeURIComponent(new URL(address).pathname.slice(1)) as Seat.SeatOperationId
        try {
          for await (const value of scope.remote.seatApprovals.watchOperation({ operationId }, signal)) yield { ok: true, value }
        } catch (error) {
          if (!signal.aborted) yield { ok: false, error: remoteErrorOf(error)
            ?? new RemoteError('seat-approvals/unavailable', 'Operation observation unavailable', {}) }
        }
      },
    }), 'seat-approvals: operation resource')
    scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay', id: '@panedesk/dsh-client-ui-seat-approvals', locale: 'seatApprovals',
      inject: (): ApprovalActions => ({
        mutate: async (item, action) => {
          const operationId = randomUUID() as Seat.SeatOperationId
          const request = { queueItemId: item.queueItemId, expectedStateVersion: item.stateVersion, operationId }
          try {
            const result = await scope.remote.seatApprovals[action](request)
            return { operationId, result }
          } catch (error) {
            // A carrier exception cannot establish whether the durable write committed.
            return { operationId, result: { ok: false, error: remoteErrorOf(error)
              ?? new RemoteError('seat-approvals/unavailable', 'Mutation outcome unavailable', {}) } }
          }
        },
      }),
    }, ApprovalPanel))
  })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
