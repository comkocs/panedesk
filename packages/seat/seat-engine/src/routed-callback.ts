/** Routed callbacks retain the journal's original identity across authorization lifetimes. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import { callbackFailure, callbackObservation, type CallbackAttempt,
  type CallbackChainRequest as ChainRequest, type CallbackChainResponse as ChainResponse,
  type CallbackIssuerPort, type CallbackRouterPort } from './routed-callback-types.ts'
import type * as T from '@panedesk/dsh-seat'
import type { SeatEngine } from './engine.ts'
import { canonical, digest } from './journal.ts'
import { fact } from './triggers.ts'

type CallbackRequest = Extract<ChainRequest, { method: 'source.deliverCallback' }>
type QueryAttempt = T.SeatCallbackAttemptResult<T.NodeWorkChainOperationResult>

function identity(engine: SeatEngine, body: T.DeliverSourceCallbackRequest): T.NodeWorkChainOperationKey | undefined {
  const accepted = engine.journal.projection.authorizationDecisions.flatMap(frame => frame.effects).find(effect =>
    effect.kind === 'node-route/accepted' && canonical(effect.data.route) === canonical(body.route)
    && engine.journal.projection.decisions.some(frame => frame.effects.some(intent =>
      (intent.kind === 'trigger/accepted' || intent.kind === 'trigger/coalesced')
      && intent.data.trigger.sourceId === body.callback.sourceId && intent.data.trigger.triggerId === body.callback.triggerId
      && intent.data.pending.frozenOpen?.nodeWorkChain?.authorizationRef === effect.data.authorizationRef)))
  if (accepted?.kind !== 'node-route/accepted') return undefined
  return { sourceNodeId: engine.options.nodeId, principalId: accepted.data.operationKey.principalId,
    sourceId: body.route.sourceId, ownerEpoch: body.route.ownerEpoch, method: 'source.deliverCallback',
    operationId: body.route.originalOperationId, callbackId: body.callback.callbackId }
}

/** Read an exact persisted callback without issuing authority or modifying delivery state.
 * @param engine - Live journal owner, recovered before the lookup.
 * @param request - Complete callback business key and original payload digest.
 * @returns Detached frozen route, callback and model evidence, or absence on any mismatch.
 */
export async function queryRoutedCallback(engine: SeatEngine,
  request: T.NodeWorkChainOperationRequest): Promise<T.DeliverSourceCallbackRequest | undefined> {
  await engine.ready()
  const body = request.key.callbackId && engine.journal.projection.callbacks.get(request.key.callbackId)?.nodeWorkChain
  if (!body || body.payloadDigest !== request.payloadDigest) return undefined
  const key = identity(engine, body)
  return key && canonical(key) === canonical(request.key) ? structuredClone(body) : undefined
}

function failure(response: Exclude<ChainResponse, { status: 'ok' }>): T.SeatRejected {
  return { status: 'rejected', error: { code: response.error.code, message: 'Callback routing did not complete',
    alternative: 'Restore the original callback route and retry.', retryable: response.error.retryable,
    effectState: response.error.effectState, ...(response.error.cause ? { cause: response.error.cause } : {}) } }
}

async function bounded<R>(work: () => Promise<R>, milliseconds: number): Promise<R> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work(), new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { reject(new Error('Callback attempt timed out')) }, milliseconds)
    })])
  } finally { if (timeout) clearTimeout(timeout) }
}

/** Resolve only the selected route's optional services; never fall back to a local source.
 * @param ctx - Explicit composition service store.
 * @param engine - Durable callback owner.
 * @param body - Original persisted delivery, never rebuilt from current model settings.
 * @returns Exact owner completion or a conservative failure with one bounded observation.
 */
export async function deliverRoutedCallback(ctx: Context, engine: SeatEngine,
  body: T.DeliverSourceCallbackRequest): Promise<CallbackAttempt> {
  const pending: T.DeliverSourceCallbackResult = { status: 'pending', callbackId: body.callback.callbackId,
    payloadDigest: body.payloadDigest }
  const retained = engine.journal.projection.callbacks.get(body.callback.callbackId)
  const uncertain = retained?.responseClass === 'unknown'
  const unknown = (diagnostic?: T.SeatCallbackDiagnostic): CallbackAttempt => ({
    ...callbackFailure(body, 'retained', 'Callback owner outcome is unknown', 'unavailable', 'unknown', 'outcome-unknown'),
    ...(diagnostic ? { diagnostic } : {}),
  })
  const refusal = (attempt: CallbackAttempt): CallbackAttempt => uncertain ? unknown(attempt.diagnostic) : attempt
  const key = identity(engine, body)
  const { payloadDigest, ...payload } = body
  if (!key || !retained?.nodeWorkChain || canonical(retained.nodeWorkChain) !== canonical(body)
    || digest(payload) !== payloadDigest || digest(body.callback) !== retained.payloadDigest) {
    return refusal(callbackFailure(body, 'retained', 'Retained callback identity did not match',
      'callback-protocol-error', 'none', 'evidence-digest-mismatch'))
  }
  const self = body.route.sourceOwnerNodeId === engine.options.nodeId
    && body.route.targetNodeId === engine.options.nodeId && body.callback.nodeId === engine.options.nodeId
  const queryStage = self ? 'local-query' : 'peer-query'
  const dispatchStage = self ? 'local-dispatch' : 'peer-dispatch'
  let query: () => Promise<QueryAttempt>
  let deliver: () => Promise<CallbackAttempt>
  const exact = { key, payloadDigest: body.payloadDigest }
  if (self) {
    const owner = ctx.get('seatLocalCallbackOwner')
    if (!owner) return refusal(callbackFailure(body, queryStage, 'Local callback owner is unavailable'))
    const current = () => ctx.get('seatLocalCallbackOwner') === owner && owner.available()
    const invoke = async <R extends T.NodeWorkChainOperationResult | T.DeliverSourceCallbackResult>(
      work: () => Promise<T.SeatCallbackAttemptResult<R>>, stage: T.SeatCallbackFailureStage):
    Promise<T.SeatCallbackAttemptResult<R> | T.SeatCallbackAttemptResult<T.SeatRejected>> => {
      await owner.ready()
      if (!current()) return callbackFailure(body, stage, 'Local callback owner is not ready')
      const attempt = await work()
      if (!current()) return callbackFailure(body, stage, 'Local callback owner was withdrawn')
      return callbackObservation(body, attempt, stage)
    }
    query = () => invoke(() => owner.query(structuredClone(exact)), queryStage)
    deliver = () => invoke(() => owner.deliver(structuredClone(body), structuredClone(key)), dispatchStage)
  } else {
    const store: {
      get(name: 'nodeWorkChain'): CallbackIssuerPort | undefined
      get(name: 'nodeWorkChainRouter'): CallbackRouterPort | undefined
    } = ctx
    const router = store.get('nodeWorkChainRouter')
    if (!router || !store.get('nodeWorkChain')?.outboxIssuer) {
      return refusal(callbackFailure(body, !router ? queryStage : 'issuer', 'Callback routing service is unavailable'))
    }
    const deadline = () => new Date(Date.now() + engine.options.config.callbackTimeoutMs).toISOString()
    const original: CallbackRequest = { version: 'node-link/v1', requestId: randomUUID() as ChainRequest['requestId'],
      sourceNodeId: key.sourceNodeId, targetNodeId: body.route.sourceOwnerNodeId, operationId: key.operationId,
      deadline: deadline(), hop: 1, method: 'source.deliverCallback', payload: structuredClone(body), payloadDigest: body.payloadDigest,
      delegation: { kind: 'node-delegation', hop: 1, principalId: key.principalId,
        authorizationRef: body.callback.callbackId as string as T.AuthorizationRef,
        sourceNodeId: key.sourceNodeId, targetNodeId: body.route.sourceOwnerNodeId,
        operationId: key.operationId, requestDigest: body.payloadDigest, taskIds: body.callback.relatedTaskIds, expiresAt: deadline() } }
    const send = async (request: ChainRequest, stage: T.SeatCallbackFailureStage):
    Promise<T.SeatCallbackAttemptResult<Extract<ChainResponse, { status: 'ok' }> | T.SeatRejected>> => {
      let grant: T.SeatAuthorizationGrant | T.SeatRejected
      try {
        const issuer = await store.get('nodeWorkChain')?.outboxIssuer?.(structuredClone(original))
        if (!issuer) return callbackFailure(body, 'issuer', 'Callback issuer is unavailable')
        grant = await issuer.check({ operationId: request.operationId, requestDigest: request.payloadDigest })
      } catch (_error) {
        return callbackFailure(body, 'issuer', 'Callback issuer could not be read')
      }
      if ('status' in grant) return callbackObservation(body, { result: grant }, 'issuer')
      const issued = grant.fact
      if (issued.principalId !== key.principalId || issued.nodeId !== key.sourceNodeId) {
        return callbackFailure(body, 'issuer', 'Callback issuer identity did not match', 'unauthorized', 'none',
          issued.principalId !== key.principalId ? 'principal-mismatch' : 'node-mismatch')
      }
      const expiresAt = deadline()
      const response = await router.route({ ...request, requestId: randomUUID() as ChainRequest['requestId'], deadline: expiresAt,
        delegation: { kind: 'node-delegation', hop: 1, authorizationRef: issued.authorizationId, principalId: issued.principalId,
          sourceNodeId: issued.nodeId, targetNodeId: original.targetNodeId, operationId: issued.operationId,
          requestDigest: issued.requestDigest, taskIds: issued.taskIds, expiresAt,
          ...(issued.seat === undefined ? {} : { seat: issued.seat }),
          ...(issued.sessionId === undefined ? {} : { sessionId: issued.sessionId }) } }, grant)
      return response.status === 'ok' ? { result: response } : callbackObservation(body, { result: failure(response) }, stage)
    }
    query = async () => {
      const attempt = await send({ ...original, method: 'chain.operation', payload: exact, payloadDigest: digest(exact) }, queryStage)
      const response = attempt.result
      if (response.status === 'rejected') return { ...attempt, result: response }
      if (response.method === 'chain.operation') return callbackObservation(body,
        { ...attempt, result: response.result }, queryStage)
      return callbackFailure(body, queryStage, 'Callback query method did not match', 'callback-protocol-error', 'none',
        'method-not-allowed')    }
    deliver = async () => {
      const attempt = await send(original, dispatchStage), response = attempt.result
      if (response.status === 'rejected') return { ...attempt, result: response }
      if (response.method === 'source.deliverCallback') {
        return callbackObservation(body, { ...attempt, result: response.result }, dispatchStage)
      }
      return callbackFailure(body, dispatchStage, 'Callback delivery method did not match', 'callback-protocol-error', 'unknown', 'method-not-allowed')
    }
  }
  const read = async (): Promise<QueryAttempt> => {
    try { return await bounded(query, engine.options.config.callbackTimeoutMs) }
    catch (_error) {
      return callbackFailure(body, queryStage, 'Callback owner query did not complete')    }
  }
  const outcome = (attempt: QueryAttempt, barrier: boolean): CallbackAttempt | undefined => {
    const result = attempt.result
    if (result.status === 'settled' && result.method === 'source.deliverCallback') {
      const settled = result.result
      if (settled.status !== 'rejected' && settled.callbackId === body.callback.callbackId
        && settled.payloadDigest === body.payloadDigest) {
        if (!barrier || settled.status === 'committed' || settled.status === 'paused') {
          return callbackObservation(body,
            { result: settled, ...(attempt.diagnostic ? { diagnostic: attempt.diagnostic } : {}) }, queryStage)
        }
      }
    }
    if (barrier) return unknown(attempt.diagnostic)
    if (result.status === 'missing') return undefined
    if (result.status === 'rejected') return callbackObservation(body, { ...attempt, result }, queryStage)
    if (result.status === 'pending') return result.effectState === 'unknown' ? unknown(attempt.diagnostic) : { ...attempt, result: pending }
    return callbackFailure(body, queryStage, 'Callback settled identity did not match', 'callback-protocol-error', 'none', 'operation-payload-conflict')
  }
  const before = outcome(await read(), uncertain)
  if (before) return before
  // Durable uncertainty precedes any business call, including calls into a same-process owner.
  await engine.journal.commit((view) => {
    const delivery = view.callbacks.get(body.callback.callbackId)
    return delivery ? [fact({ kind: 'callback/attempted', operationId: key.operationId,
      data: { ...delivery, responseClass: 'unknown' } })] : []
  })
  let sent: CallbackAttempt
  try { sent = await bounded(deliver, engine.options.config.callbackTimeoutMs) }
  catch (_error) {
    const reconciled = outcome(await read(), true) ?? unknown()
    return reconciled.result.status === 'rejected' && reconciled.result.error.effectState === 'unknown'
      ? { ...reconciled, diagnostic: callbackFailure(body, dispatchStage, 'Callback dispatch did not complete',
        'unavailable', 'unknown', 'outcome-unknown').diagnostic } : reconciled
  }
  if (sent.result.status === 'committed' && sent.result.callbackId === body.callback.callbackId
    && sent.result.payloadDigest === body.payloadDigest) return sent
  if (sent.result.status === 'paused' && sent.result.callbackId === body.callback.callbackId
    && sent.result.payloadDigest === body.payloadDigest) return sent
  if (!self && sent.result.status === 'pending' && sent.result.callbackId === body.callback.callbackId
    && sent.result.payloadDigest === body.payloadDigest) return sent
  if (!self && sent.result.status === 'rejected' && sent.result.error.effectState === 'none'
    && sent.diagnostic?.stage === 'peer-dispatch') return sent
  const reconciled = outcome(await read(), true) ?? unknown(sent.diagnostic)
  return sent.diagnostic && reconciled.result.status === 'rejected' && reconciled.result.error.effectState === 'unknown'
    ? { ...reconciled, diagnostic: sent.diagnostic } : reconciled
}
