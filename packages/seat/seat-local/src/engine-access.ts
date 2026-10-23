/** Provider-owned closures keep internal authority out of the external SeatService instance. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import { localSourceId } from './open-admission.ts'
import { readLocalOpenInput } from './open-input.ts'
import { readSeatText, renderOpening } from './template.ts'
import type { LocalSeatOptions } from './service-options.ts'

/** Register read-only closures for local policy consumers under provider-owned authority.
 * @param ctx - provider lifecycle owning the registration.
 * @param service - unscoped local provider, which remains unauthorized.
 * @param options - verified local node identity.
 */
export function registerLocalReadAccess(ctx: Context, service: T.SeatService, options: LocalSeatOptions): void {
  const internal = service.withAuthority({ principalId: 'seat-local-read' as T.SeatPrincipalId,
    origin: 'engine', nodeId: options.nodeId })
  ctx.provide('seatLocalRead', Object.freeze({
    definitions: (request: T.ListSeatDefinitionsRequest) => internal.definitions(request),
    binding: (request: T.SeatBindingRequest) => internal.binding(request),
    list: (request: T.ListSeatWindowsRequest) => internal.list(request),
  }))
}

/** Capture the internal caller once and expose only engine-required operations.
 * @param service - unscoped local provider.
 * @param options - explicit node identity and template bound.
 * @returns engine-only capabilities; the unscoped provider stays unauthorized.
 */
export function createEngineAccess(service: T.SeatService, options: LocalSeatOptions): T.SeatEngineLocalAccess {
  const internal = service.withAuthority({ principalId: 'seat-engine' as T.SeatPrincipalId,
    origin: 'engine', nodeId: options.nodeId })
  return {
    list: request => internal.list(request),
    close: request => internal.close(request),
    freeze: async (definition, trigger) => {
      if (trigger.sourceId === localSourceId) {
        const input = readLocalOpenInput(trigger.data)
        return { definition: input.definition, title: input.title, frozenOpening: input.opening,
          openingMode: input.request.origin === 'manual' ? input.request.openingMode ?? 'auto' : 'auto' }
      }
      const date = trigger.receivedAt.slice(0, 10)
      const frozenOpening = renderOpening(await readSeatText(definition.opening, options.maxOpeningBytes),
        { seat: definition.seat, date, taskId: trigger.taskId ?? null }, options.maxOpeningBytes)
      return { definition, title: `${definition.seat} ${date.slice(5)}`, frozenOpening, openingMode: 'auto' }
    },
  }
}
