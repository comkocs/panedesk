/** Provider-owned closures keep internal authority out of the external SeatService instance. */
import type { Context } from '@panedesk/cordis'
import type * as T from '@panedesk/dsh-seat'
import { localSourceId } from './open-admission.ts'
import { readLocalOpenInput } from './open-input.ts'
import { formatTemplateDate, readSeatText, renderOpening } from './template.ts'
import type { LocalSeatOptions } from './service-options.ts'
import { rejected, refuse } from './errors.ts'
import type { OpeningContexts } from './opening-contexts.ts'
import { digest } from './store.ts'

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
      const invoke = async <R>(request: { operationId: T.SeatOperationId; sessionId?: import('@panedesk/dsh-session').SessionId; seat?: T.SeatName },
        run: (scoped: T.SeatService) => Promise<R>): Promise<R | T.SeatRejected> => {
        const issuers = ctx.get('seatAuthorizationIssuers')
        if (!issuers) return run(internal)
        const binding = request.sessionId ? await internal.binding({ sessionId: request.sessionId }) : null
        if (binding && 'status' in binding) return binding
        const registration = issuers.register({ identity: { kind: 'model-tool-call', principalId: authority.principalId,
          origin: authority.origin, nodeId: authority.nodeId, sessionId, callId,
          ...(request.seat ? { seat: request.seat } : binding?.kind === 'seat' ? { seat: binding.seat } : {}),
          taskIds: binding?.kind === 'seat' ? binding.relatedTaskIds : [], policyRevision: 0 },
        current: () => active && ctx.get('agents')?.get(sessionId)?.session === session
          ? { decision: 'allowed', reasonCode: 'live-model-invocation', policyRevision: 0 } : null })
        try {
          const grant = await registration.issuer.check({ operationId, requestDigest: digest(request), callId })
          if ('status' in grant) return grant
          return await run(service.withAuthority({ ...authority, authorization: grant }))
        } finally { registration.dispose() }
      }
      return Object.freeze({
        open: async (request: T.OpenSeatRequest) => {
          authorize()
          const issuers = ctx.get('seatAuthorizationIssuers')
          if (!issuers) return internal.open({ ...request, operationId, origin: 'manual' })
          const input: T.OpenSeatRequest = { ...request, operationId, origin: 'manual', openingMode: request.openingMode ?? 'auto' }
          const registration = issuers.register({ identity: { kind: 'model-tool-call', principalId: authority.principalId,
            origin: authority.origin, nodeId: authority.nodeId, sessionId, callId, seat: request.seat,
            taskIds: request.taskId ? [request.taskId] : [], policyRevision: 0 },
          current: () => active && ctx.get('agents')?.get(sessionId)?.session === session
            ? { decision: 'allowed', reasonCode: 'live-model-invocation', policyRevision: 0 } : null })
          try {
            const grant = await registration.issuer.check({ operationId, requestDigest: digest(input), callId })
            if ('status' in grant) return grant
            return await service.withAuthority({ ...authority, authorization: grant }).open(input)
          } finally { registration.dispose() }
        },
        renew: async (request: T.RenewSeatRequest) => {
          authorize()
          const input = { ...request, operationId }
          const result = await invoke(input, scoped => scoped.renew(input))
          return result.status === 'rejected' && !('cacheEvidence' in result)
            ? { ...result, cacheEvidence: { lastActivityAt: null, cacheTtlMs: null, prefixDigest: null,
              observedAt: new Date().toISOString(), reusableRequest: false } } : result
        },
        replace: async (request: T.ReplaceSeatRequest) => {
          authorize()
          const input = { ...request, operationId }
          return invoke(input, scoped => scoped.replace(input))
        },
        close: async (request: T.CloseSeatRequest) => {
          authorize()
          const input = { ...request, operationId }
          return invoke(input, scoped => scoped.close(input))
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
    ...(internal.messageWindows ? { messageWindows: internal.messageWindows.bind(internal) } : {}),
  }))
}

/** Capture the internal caller once and expose only engine-required operations.
 * @param service - unscoped local provider.
 * @param options - explicit node identity and template bound.
 * @param contexts - Optional source registry sharing the manual entry freezer.
 * @returns engine-only capabilities; the unscoped provider stays unauthorized.
 */
export function createEngineAccess(service: T.SeatService, options: LocalSeatOptions, contexts?: OpeningContexts): T.SeatEngineLocalAccess {
  const authority: T.SeatCallContext = { principalId: 'seat-engine' as T.SeatPrincipalId,
    origin: 'engine', nodeId: options.nodeId }
  const internal = service.withAuthority(authority)
  return {
    requiresRecheck: () => contexts?.requiresRecheck() ?? false,
    ...(contexts ? { recheck: (item: T.PendingSeatItem) => contexts.recheck(item) } : {}),
    list: request => internal.list(request),
    close: async (request) => {
      const issuers = service['ctx'].get('seatAuthorizationIssuers')
      if (!issuers) return internal.close(request)
      const binding = await internal.binding({ sessionId: request.sessionId })
      if (!binding || 'status' in binding || binding.kind !== 'seat') return rejected('unauthorized',
        'Engine close requires a current seat binding.', 'Reconcile the target window.')
      const registration = issuers.register({ identity: { kind: 'engine', principalId: authority.principalId,
        origin: 'engine', nodeId: options.nodeId, seat: binding.seat, taskIds: binding.relatedTaskIds, policyRevision: 0 },
      current: () => service['ctx'].get('seatAuthorizationIssuers') === issuers
        ? { decision: 'allowed', reasonCode: 'local-engine-owner', policyRevision: 0 } : null })
      try {
        const grant = await registration.issuer.check({ operationId: request.operationId, requestDigest: digest(request) })
        return 'status' in grant ? grant : await service.withAuthority({ ...authority, authorization: grant }).close(request)
      } finally { registration.dispose() }
    },
    freezeContext: async (definition, trigger) => {
      if (!contexts || !trigger.openingContext || !trigger.relatedTaskIds) return rejected('unavailable',
        'Opening context is unavailable.', 'Restore the provider and task associations.')
      const snapshot = await contexts.resolve({ openingContext: trigger.openingContext, relatedTaskIds: trigger.relatedTaskIds }, authority)
      if ('status' in snapshot) return snapshot
      const date = formatTemplateDate(new Date(trigger.receivedAt), service['ctx'].get('seatGates')?.getTimeZone() ?? 'UTC')
      return { definition, title: `${definition.seat} ${date.slice(5)}`, openingMode: 'auto', openingContext: snapshot,
        frozenOpening: { text: snapshot.text, digest: snapshot.digest,
          variables: { seat: definition.seat, date, taskId: trigger.taskId ?? null } } }
    },
    freeze: async (definition, trigger) => {
      if (trigger.sourceId === localSourceId) {
        const input = readLocalOpenInput(trigger.data)
        return { definition: input.definition, title: input.title, frozenOpening: input.opening,
          openingMode: input.request.origin === 'manual' ? input.request.openingMode ?? 'auto' : 'auto',
          ...(input.openingContext ? { openingContext: input.openingContext } : {}) }
      }
      const date = formatTemplateDate(new Date(trigger.receivedAt), service['ctx'].get('seatGates')?.getTimeZone() ?? 'UTC')
      const titleDate = date.slice(5)
      const frozenOpening = renderOpening(await readSeatText(definition.opening, options.maxOpeningBytes),
        { seat: definition.seat, date, taskId: trigger.taskId ?? null }, options.maxOpeningBytes)
      return { definition, title: `${definition.seat} ${titleDate}`, frozenOpening, openingMode: 'auto' }
    },
  }
}
