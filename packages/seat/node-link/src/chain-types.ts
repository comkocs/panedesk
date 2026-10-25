/** Opt-in work-chain frames remain separate from the legacy eight-method transport. */
import type { Branded } from '@panedesk/dsh-brand'
import type * as Seat from '@panedesk/dsh-seat'
import type { NodeLinkFailure } from './index.ts'

/** Closed chain frame with the original method and complete frozen payload. */
export type ChainRequest = { [M in Seat.NodeWorkChainMethod]: {
  version: 'node-link/v1'
  requestId: Branded<'NodeRequestId'>
  sourceNodeId: Seat.SeatNodeId
  targetNodeId: Seat.SeatNodeId
  operationId: Seat.SeatOperationId
  deadline: Seat.SeatTimestamp
  hop: 1
  method: M
  payload: Seat.NodeWorkChainMethodMap[M]['request']
  payloadDigest: Seat.SeatDigest
  delegation: Seat.SeatNodeDelegation
} }[Seat.NodeWorkChainMethod]

/** Safe chain failures retain both the compatibility category and precise cause. */
export interface ChainFailure extends NodeLinkFailure {
  cause: Seat.SeatFailureCause
}

/** Every response correlates the authenticated call and preserves the method result. */
export type ChainResponse = { [M in Seat.NodeWorkChainMethod]: {
  version: 'node-link/v1'
  requestId: Branded<'NodeRequestId'>
  sourceNodeId: Seat.SeatNodeId
  targetNodeId: Seat.SeatNodeId
  operationId: Seat.SeatOperationId
  method: M
} & ({ status: 'ok'; result: Seat.NodeWorkChainMethodMap[M]['result'] }
  | { status: 'unavailable' | 'rejected' | 'uncertain'; error: ChainFailure }) }[Seat.NodeWorkChainMethod]

/** Capability is omitted until every advertised receiving method is ready. */
export interface ChainCapability {
  capability: 'node-work-chain/v1'
  maxFrameBytes: number
  methods: readonly Seat.NodeWorkChainMethod[]
}

/** Evidence control frames do not carry recursively issued delegations. */
export interface ChainEvidenceFrame {
  type: 'delegation-evidence'
  version: 'node-link/v1'
  requestId: Branded<'NodeRequestId'>
  request: Seat.NodeDelegationEvidenceRequest
}

/** Evidence replies correlate the lookup before retained facts can be consumed. */
export interface ChainEvidenceResponse {
  type: 'delegation-evidence'
  version: 'node-link/v1'
  requestId: Branded<'NodeRequestId'>
  result: Seat.NodeDelegationEvidenceResult
}
