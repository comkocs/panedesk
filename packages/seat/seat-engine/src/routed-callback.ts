/** Routed callbacks retain the journal's original identity across authorization lifetimes. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import type { CallbackChainRequest as ChainRequest, CallbackChainResponse as ChainResponse,
  CallbackIssuerPort, CallbackRouterPort } from './routed-callback-types.ts'
import type * as T from '@panedesk/dsh-seat'
import type { SeatEngine } from './engine.ts'
import { canonical, digest } from './journal.ts'
import { fact, rejected } from './triggers.ts'

type CallbackRequest = Extract<ChainRequest, { method: 'source.deliverCallback' }>

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

/** Resolve optional chain services on each attempt; no local-source fallback is permitted.
 * @param ctx - Explicit composition service store.
 * @param engine - Durable callback owner.
 * @param body - Original persisted delivery, never rebuilt from current model settings.
 * @returns Owner completion or a retryable pending result; authentication refusals remain intact.
 */
export async function deliverRoutedCallback(ctx: Context, engine: SeatEngine,
  body: T.DeliverSourceCallbackRequest): Promise<T.DeliverSourceCallbackResult> {
  const pending: T.DeliverSourceCallbackResult = { status: 'pending', callbackId: body.callback.callbackId,
    payloadDigest: body.payloadDigest }
  const unknown: T.SeatRejected = { ...rejected('unavailable', 'Callback owner outcome is unknown'),
    error: { ...rejected('unavailable', 'Callback owner outcome is unknown').error, effectState: 'unknown', retryable: false } }
  const retained = engine.journal.projection.callbacks.get(body.callback.callbackId)
  const uncertain = retained?.responseClass === 'unknown'
  const store: {
    get(name: 'nodeWorkChain'): CallbackIssuerPort | undefined
    get(name: 'nodeWorkChainRouter'): CallbackRouterPort | undefined
  } = ctx
  const services = store.get('nodeWorkChain')
  const router = store.get('nodeWorkChainRouter')
  const key = identity(engine, body)
  if (!services?.outboxIssuer || !router || !key) return uncertain ? unknown : pending
  const deadline = () => new Date(Date.now() + engine.options.config.callbackTimeoutMs).toISOString()
  const original: CallbackRequest = { version: 'node-link/v1', requestId: randomUUID() as ChainRequest['requestId'],
    sourceNodeId: key.sourceNodeId, targetNodeId: body.route.sourceOwnerNodeId, operationId: key.operationId,
    deadline: deadline(), hop: 1, method: 'source.deliverCallback', payload: structuredClone(body), payloadDigest: body.payloadDigest,
    delegation: { kind: 'node-delegation', hop: 1, principalId: key.principalId,
      authorizationRef: body.callback.callbackId as string as T.AuthorizationRef,
      sourceNodeId: key.sourceNodeId, targetNodeId: body.route.sourceOwnerNodeId,
      operationId: key.operationId, requestDigest: body.payloadDigest, taskIds: body.callback.relatedTaskIds, expiresAt: deadline() } }
  const fresh: T.SeatAuthorizationIssuer = { check: async (request) => {
    const current = store.get('nodeWorkChain')
    const issuer = await current?.outboxIssuer?.(structuredClone(original))
    return issuer ? issuer.check(request) : rejected('unavailable', 'Callback issuer is unavailable')
  } }
  const send = async (request: ChainRequest): Promise<ChainResponse | undefined> => {
    const grant = await fresh.check({ operationId: request.operationId, requestDigest: request.payloadDigest })
    if ('status' in grant) return undefined
    const fact = grant.fact
    if (fact.principalId !== key.principalId || fact.nodeId !== key.sourceNodeId) return undefined
    const expiresAt = deadline()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const result = router.route({ ...request, requestId: randomUUID() as ChainRequest['requestId'], deadline: expiresAt,
      delegation: { kind: 'node-delegation', hop: 1, authorizationRef: fact.authorizationId, principalId: fact.principalId,
        sourceNodeId: fact.nodeId, targetNodeId: original.targetNodeId, operationId: fact.operationId,
        requestDigest: fact.requestDigest, taskIds: fact.taskIds, expiresAt,
        ...(fact.seat === undefined ? {} : { seat: fact.seat }),
        ...(fact.sessionId === undefined ? {} : { sessionId: fact.sessionId }) } }, grant)
    try {
      return await Promise.race([result, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { reject(new Error('Callback route timed out')) }, engine.options.config.callbackTimeoutMs)
      })])
    } finally { if (timeout) clearTimeout(timeout) }
  }
  const payload = { key, payloadDigest: body.payloadDigest }
  const query = (): Promise<ChainResponse | undefined> => send({ ...original, method: 'chain.operation', payload,
    payloadDigest: digest(payload) })
  const outcome = (response: ChainResponse | undefined): T.DeliverSourceCallbackResult | undefined => {
    if (!response) return pending
    if (response.status !== 'ok') return failure(response)
    if (response.method === 'source.deliverCallback') return response.result
    if (response.method !== 'chain.operation') return pending
    if (response.result.status === 'settled') return response.result.method === 'source.deliverCallback' ? response.result.result : pending
    if (response.result.status === 'rejected') return response.result
    return response.result.status === 'missing' ? undefined : pending
  }
  const exact = async (): Promise<ChainResponse | undefined> => {
    try { return await query() }
    catch (_error) { return undefined } // Failed reads cannot establish owner-side absence.
  }
  const resolved = (response: ChainResponse | undefined): T.DeliverSourceCallbackResult => {
    if (response?.status === 'ok' && response.method === 'chain.operation' && response.result.status === 'settled') {
      return outcome(response) ?? unknown
    }
    return unknown
  }
  const before = await exact()
  if (uncertain) return resolved(before)
  const known = outcome(before)
  if (known) return known
  // Persist uncertainty before dispatch so process loss cannot authorize another business send.
  await engine.journal.commit((view) => {
    const delivery = view.callbacks.get(body.callback.callbackId)
    return delivery ? [fact({ kind: 'callback/attempted', operationId: key.operationId,
      data: { ...delivery, responseClass: 'unknown' } })] : []
  })
  let response: ChainResponse | undefined
  try { response = await send(original) }
  catch (_error) { return resolved(await exact()) } // Reconcile this attempt before returning an unknown transport outcome.
  if (!response) return pending
  if (response.status !== 'ok' && response.error.effectState === 'unknown') return resolved(await exact())
  return outcome(response) ?? pending
}
