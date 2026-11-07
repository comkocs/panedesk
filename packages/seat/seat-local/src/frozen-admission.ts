/** Frozen seat entry keeps the original wire identity while deriving one local opening action. */
import type * as T from '@panedesk/dsh-seat'
import { queuedOpenResult } from './open-admission.ts'
import { digest } from './store.ts'
import { rejected } from './errors.ts'

/** Capture the authenticated sender without substituting the source owner.
 * @param request - Original frozen wire payload.
 * @param authority - Locally issued delegation context.
 * @param method - Invoked seat method.
 * @returns Required admission data, or refusal before local action derivation.
 */
export function seatFrozenIdentity(request: T.OpenFrozenSeatRequest | T.WakeFrozenSeatRequest,
  authority: T.SeatCallContext, method: 'seat.openFrozen' | 'seat.wakeFrozen'): T.NodeWorkChainAcceptedData | T.SeatRejected {
  if (request.route.targetNodeId !== authority.nodeId
    || request.request.nodeId !== undefined && request.request.nodeId !== authority.nodeId) {
    return rejected('invalid-request', 'Frozen admission caller does not match the route.', 'Use the original request.')
  }
  return { capability: 'node-work-chain/v1', route: structuredClone(request.route),
    openingContext: structuredClone(request.openingContext), expectedSeatRevision: request.expectedSeatRevision,
    payloadDigest: digest(request), trigger: null,
    operationKey: { sourceNodeId: request.route.sourceOwnerNodeId, principalId: authority.principalId,
      sourceId: request.route.sourceId, ownerEpoch: request.route.ownerEpoch,
      operationId: request.request.operationId, method } }
}

/** Query original accepted intent rather than the mutable queue or operation-only legacy lookup.
 * @param effects - Recovered local journal projection.
 * @param request - Complete business identity and digest.
 * @param authority - Independently authenticated query caller.
 * @returns First acknowledgement, exact conflict, or absence after recovery.
 */
export function querySeatFrozen(effects: readonly T.EngineEffect[], request: T.NodeWorkChainOperationRequest,
  authority: T.SeatCallContext): T.NodeWorkChainOperationResult {
  if (authority.principalId !== request.key.principalId) {
    return rejected('invalid-request', 'Frozen query caller does not match.', 'Use the original caller.')
  }
  for (const effect of effects) {
    if (effect.kind !== 'trigger/accepted' && effect.kind !== 'trigger/coalesced') continue
    const pending = effect.data.pending, chain = pending.frozenOpen?.nodeWorkChain
    if (!chain || digest(chain.operationKey) !== digest(request.key)) continue
    if (chain.payloadDigest !== request.payloadDigest) {
      return rejected('operation-id-conflict', 'Frozen operation payload conflicts.', 'Use the original payload.')
    }
    const result = queuedOpenResult(pending)
    if (request.key.method === 'seat.openFrozen') return { status: 'settled', method: 'seat.openFrozen', result }
    if (request.key.method === 'seat.wakeFrozen') return { status: 'settled', method: 'seat.wakeFrozen', result: { status: 'opened', result } }
  }
  return { status: 'missing' }
}
