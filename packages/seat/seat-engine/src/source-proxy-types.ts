/** In-process source composition supplies frozen owner evidence, never an issuer to the engine. */
import type * as T from '@panedesk/dsh-seat'

/** Original local inputs are retained separately from their frozen wire payloads. */
export interface SourceProxyInputs {
  'engine.acceptFrozen': T.TriggerEnvelope
  'seat.openFrozen': T.OpenSeatWithContextRequest
  'seat.wakeFrozen': T.WakeSeatWithContextRequest
}
/** Each result belongs to the method whose intent was durably reserved. */
export type SourceProxyOutcome<M extends T.SeatRemoteOpeningMethod> =
  | { status: 'committed'; result: T.NodeWorkChainMethodMap[M]['result'] }
  | { status: 'rejected'; result: T.SeatRejected }
  | { status: 'unknown' }
/** The original grant stays process-local; only its verified fact enters persistence. */
export interface SourceProxySend<M extends T.SeatRemoteOpeningMethod> {
  method: M
  targetNodeId: T.SeatNodeId
  operationId: T.SeatOperationId
  payload: T.NodeWorkChainMethodMap[M]['request']
  original: T.SeatAuthorizationGrant
}
/** Trusted composition owns route selection, source preparation and restricted outbox signing. */
export interface SourceProxyPort {
  /** Resolve ownership without allocating a reservation; absence keeps the legacy path.
   * @param seat - Original target seat.
   * @returns Explicit target node, or absence when this composition does not route the seat.
   */
  target(seat: T.SeatName): Promise<T.SeatNodeId | undefined>
  /** Freeze at the sole source owner; replay is handled before this call.
   * @param request - Local input and selected target; caller authority is present for open and wake.
   * @returns Owner-retained frozen payload and the original local-action grant, or a safe refusal.
   */
  prepare<M extends T.SeatRemoteOpeningMethod>(request: {
    method: M
    input: SourceProxyInputs[M]
    targetNodeId: T.SeatNodeId
    authority?: T.SeatCallContext
  }): Promise<{
    payload: T.NodeWorkChainMethodMap[M]['request']
    original: T.SeatAuthorizationGrant
  } | T.SeatRejected>
  /** Persist composition-owned intent and sign fresh wire authority before invoking the router.
   * @param request - Complete frozen payload and original process-local local-action grant.
   * @returns Confirmed outcome; unavailable or ambiguous transport must return unknown.
   */
  send<M extends T.SeatRemoteOpeningMethod>(request: SourceProxySend<M>): Promise<SourceProxyOutcome<M>>
  /** Query the exact persisted intent with fresh restricted authority; omission retains unknown.
   * @param record - Source journal's original intent; historical facts are not live grants.
   * @returns Confirmed query outcome, or unknown without releasing the reservation.
   */
  reconcile?(record: SourceProxyRecord): Promise<SourceProxyOutcome<T.SeatRemoteOpeningMethod>>
}
/** Outgoing business records never serialize a reusable grant or allocate local execution resources. */
export type SourceProxyRecord = { [M in T.SeatRemoteOpeningMethod]: {
  method: M
  input: SourceProxyInputs[M]
  inputDigest: T.SeatDigest
  targetNodeId: T.SeatNodeId
  operationKey: T.NodeWorkChainOperationKey
  payload: T.NodeWorkChainMethodMap[M]['request']
  payloadDigest: T.SeatDigest
  original: T.SeatIssuedAuthorizationFact
  outcome: SourceProxyOutcome<M>
} }[T.SeatRemoteOpeningMethod]
/** Required outgoing records share the existing engine journal's writer and recovery barrier. */
export interface SourceProxyEffect extends T.EngineEffectBase {
  kind: 'node-source/updated'
  data: SourceProxyRecord
}
