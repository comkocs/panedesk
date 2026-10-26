/** Frozen business calls enter only existing neutral local-only services. */
import type { SeatCallContext } from '@panedesk/dsh-seat'
import type { ChainLocalServices } from './chain-services.ts'
import type { ChainRequest, ChainResponse } from './chain-types.ts'
import { chainFailure } from './chain-identity.ts'
import { decodeChainResponse } from './chain-codec.ts'

/** Resolve only the declared service method, never an arbitrary RPC namespace.
 * @param request - Exact validated call excluding the separate business query path.
 * @param authority - Process-local grant issued after independent evidence checks.
 * @param local - Host-owned local services; missing methods refuse without fallback.
 * @returns Correlated original business result.
 */
export async function dispatchChain(request: ChainRequest, authority: SeatCallContext,
  local: ChainLocalServices): Promise<ChainResponse> {
  const refused = () => chainFailure(request, 'cross-node-unsupported', 'method-not-allowed')
  if (request.method === 'chain.operation' || !local.methods.includes(request.method)) return refused()
  let result: unknown
  switch (request.method) {
    case 'seat.definitionRevision':
      if (!local.definitionRevisions?.available()) return refused()
      result = await local.definitionRevisions.read(request.payload, authority)
      break
    case 'engine.acceptFrozen':
      if (!local.engine?.acceptFrozen) return refused()
      result = await local.engine.acceptFrozen(request.payload, authority)
      break
    case 'seat.openFrozen': {
      const seats = local.seats?.withAuthority(authority)
      if (!seats?.openFrozen) return refused()
      result = await seats.openFrozen(request.payload)
      break
    }
    case 'seat.wakeFrozen': {
      const seats = local.seats?.withAuthority(authority)
      if (!seats?.wakeFrozen) return refused()
      result = await seats.wakeFrozen(request.payload)
      break
    }
    case 'source.prepareOpening':
      if (!local.opening?.prepare) return refused()
      result = await local.opening.prepare(request.payload, authority)
      break
    case 'source.checkAdmission':
      if (!local.opening?.checkAdmission) return refused()
      result = await local.opening.checkAdmission(request.payload, authority)
      break
    case 'source.deliverCallback':
      if (!local.opening?.deliverCallback) return refused()
      result = await local.opening.deliverCallback(request.payload, authority)
      break
  }
  return decodeChainResponse({ version: request.version, requestId: request.requestId, sourceNodeId: request.sourceNodeId,
    targetNodeId: request.targetNodeId, operationId: request.operationId, method: request.method, status: 'ok', result }, request)
}
