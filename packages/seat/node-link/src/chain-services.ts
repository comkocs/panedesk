/** Host-owned opt-in chain capabilities never infer authority from wire claims. */
import type * as Seat from '@panedesk/dsh-seat'
import type { NodeAuthenticatedPeer, NodeDelegationExpiryPolicy } from './delegation.ts'
import type { ChainRequest, ChainResponse, ChainFailure } from './chain-types.ts'

/** Independent retained evidence is scoped to the authenticated requesting node. */
export interface ChainEvidenceService {
  /** Restore retained evidence before announcing receiving capability.
   * @returns Completion after retained entries and revocations are available.
   */
  ready(): Promise<void>
  /** Read only the exact retained entry for this peer, never enumerate authority.
   * @param request - Exact original authorization and payload identity.
   * @param peer - Transport-derived requesting peer.
   * @returns Independent evidence or a bounded refusal.
   */
  query(request: Seat.NodeDelegationEvidenceRequest, peer: NodeAuthenticatedPeer): Promise<Seat.NodeDelegationEvidenceResult>
}

/** Policy checks stable account mapping, source ownership and current local admission. */
export interface ChainReceivingPolicy {
  readonly expiry: NodeDelegationExpiryPolicy
  /** Restore trusted identity mapping and local permission data.
   * @returns Completion after policy can evaluate all configured receiving methods.
   */
  ready(): Promise<void>
  /** Intersect original authority with stable account, source, node and local permissions.
   * @param request - Validated exact request.
   * @param peer - Authenticated channel identity.
   * @param evidence - Independently fetched retained fact, already correlated.
   * @returns Exact local issuer or structured refusal; absence is never permission.
   */
  authorize(request: ChainRequest, peer: NodeAuthenticatedPeer,
    evidence: Extract<Seat.NodeDelegationEvidenceResult, { status: 'retained' }>): Promise<Seat.SeatAuthorizationIssuer | ChainFailure>
}

/** Optional local services execute only the frozen, finite method set. */
export interface ChainLocalServices {
  readonly methods: readonly Exclude<Seat.NodeWorkChainMethod, 'chain.operation'>[]
  readonly seats?: Seat.SeatService
  readonly engine?: Seat.SeatEngineService
  readonly opening?: Seat.SeatOpeningContexts
  /** Local admission must be ready before any corresponding capability is advertised.
   * @returns Completion after local transaction owners can accept frozen intents.
   */
  ready(): Promise<void>
}

/** Opt-in router remains distinct from the unchanged legacy router API. */
export interface ChainRouterService {
  /** Send only after both peers advertise this method, retaining unknown intent.
   * @param request - Entry-authorized frozen request.
   * @param authorization - Fresh process-local entry grant matching every delegation field.
   * @returns Correlated result or explicit safe failure.
   */
  route(request: ChainRequest, authorization: Seat.SeatAuthorizationGrant): Promise<ChainResponse>
  /** Reconcile retained intents before replay; absence leaves uncertain delivery pending.
   * @param issuerFor - Exact durable-intent owner, returning fresh restricted authority per check.
   * @returns Completion of one query-before-replay pass.
   */
  recover?(issuerFor: (request: ChainRequest) => Promise<Seat.SeatAuthorizationIssuer | undefined>): Promise<void>
}

/** Explicit composition supplies every security and local-admission dependency. */
export interface ChainServices {
  readonly policy: ChainReceivingPolicy
  /** Omission uses node-link's paired persistent evidence; injection is intended for tests. */
  readonly evidence?: ChainEvidenceService
  readonly local: ChainLocalServices
  /** Optional restricted outbox entry; absence retains unknown intents without replay.
   * @param request - Complete original request read from the sender's durable store.
   * @returns Captured exact-intent issuer, or absence when this outbox does not own the intent.
   */
  outboxIssuer?(request: ChainRequest): Promise<Seat.SeatAuthorizationIssuer | undefined>
  /** Independent reserved control slots; business calls cannot consume these slots. */
  readonly maxControlPending: number
}

declare module '@panedesk/cordis' {
  interface Context {
    /** Omission preserves the complete legacy transport and performs no new storage I/O. */
    nodeWorkChain: ChainServices
    /** Available only while the explicitly installed work-chain runtime accepts calls. */
    nodeWorkChainRouter: ChainRouterService
  }
}
