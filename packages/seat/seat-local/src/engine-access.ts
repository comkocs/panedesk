/** Provider-owned closures keep internal authority out of the external SeatService instance. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import { localSourceId } from './open-admission.ts'
import { readLocalOpenInput } from './open-input.ts'
import { readSeatText, renderOpening } from './template.ts'
import type { LocalSeatOptions } from './service-options.ts'
import { rejected, refuse } from './errors.ts'

/** Register only self-owned wait and report operations for live tool callers.
 * @param ctx - provider lifecycle and live agent registry.
 * @param service - unscoped local provider, which remains unauthorized.
 * @param options - verified local node identity.
 */
export function registerLocalSessionAccess(ctx: Context, service: T.SeatService, options: LocalSeatOptions): void {
  let active = true
  ctx.effect(() => () => { active = false })
  ctx.provide('seatLocalSession', Object.freeze({
    forSession(session: import('@panedesk/dsh-session').Session): T.SeatSessionOperations {
      const sessionId = session.id
      const internal = service.withAuthority({ principalId: `session:${sessionId}` as T.SeatPrincipalId,
        origin: 'manual', nodeId: options.nodeId })
      const authorize = (target: import('@panedesk/dsh-session').SessionId) =>
        active && target === sessionId && ctx.get('agents')?.get(sessionId)?.session === session ? null
          : rejected('unauthorized', 'Only the calling live session may change its waits and reports.', 'Use your own session.')
      return Object.freeze({
        registerWait: async (request: T.RegisterSeatWaitRequest) => authorize(request.sessionId) ?? internal.registerWait(request),
        cancelWait: async (request: T.CancelSeatWaitRequest) => authorize(request.sessionId) ?? internal.cancelWait(request),
        submitReport: async (request: T.SubmitCloseReportRequest) => authorize(request.report.sessionId) ?? internal.submitReport(request),
        revokeReport: async (request: T.RevokeCloseReportRequest) => authorize(request.sessionId) ?? internal.revokeReport(request),
      })
    },
  }))
}

/** Register explicit window operations under live, invocation-local model tool authority.
 * @param ctx - provider lifecycle and live agent registry.
 * @param service - unscoped local provider, which remains unauthorized.
 * @param options - verified local node identity.
 */
export function registerLocalWindowsAccess(ctx: Context, service: T.SeatService, options: LocalSeatOptions): void {
  let active = true
  ctx.effect(() => () => { active = false })
  ctx.provide('seatLocalWindows', Object.freeze({
    forInvocation({ session, callId }: Parameters<T.SeatLocalWindowsAccess['forInvocation']>[0]): T.SeatWindowOperations {
      const sessionId = session.id
      const operationId = `tool:${sessionId}:${callId}` as T.SeatOperationId
      const authority: T.SeatModelToolAuthority = { kind: 'model-tool-call', sessionId, callId,
        principalId: `model-tool-call:${sessionId}:${callId}` as T.SeatPrincipalId,
        origin: 'manual', nodeId: options.nodeId }
      const internal = service.withAuthority(authority)
      const authorize = () => {
        if (!active || ctx.get('agents')?.get(sessionId)?.session !== session) {
          refuse('unauthorized', 'Only the calling live session may invoke window tools.', 'Use the current tool invocation.')
        }
      }
      return Object.freeze({
        open: async (request: T.OpenSeatRequest) => {
          authorize()
          return internal.open({ ...request, operationId, origin: 'manual' })
        },
        renew: async (request: T.RenewSeatRequest) => {
          authorize()
          return internal.renew({ ...request, operationId })
        },
        replace: async (request: T.ReplaceSeatRequest) => {
          authorize()
          return internal.replace({ ...request, operationId })
        },
        close: async (request: T.CloseSeatRequest) => {
          authorize()
          return internal.close({ ...request, operationId })
        },
        rename: async (request: T.RenameSeatRequest) => {
          authorize()
          return internal.rename({ ...request, operationId })
        },
        wake: async (request: T.WakeSeatRequest) => {
          authorize()
          return internal.wake({ ...request, operationId })
        },
      })
    },
  }))
}

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
      const titleDate = new Intl.DateTimeFormat('en-US', { timeZone: service['ctx'].get('seatGates')?.getTimeZone() ?? 'UTC',
        month: '2-digit', day: '2-digit' }).format(new Date(trigger.receivedAt)).replace('/', '-')
      const frozenOpening = renderOpening(await readSeatText(definition.opening, options.maxOpeningBytes),
        { seat: definition.seat, date, taskId: trigger.taskId ?? null }, options.maxOpeningBytes)
      return { definition, title: `${definition.seat} ${titleDate}`, frozenOpening, openingMode: 'auto' }
    },
  }
}
