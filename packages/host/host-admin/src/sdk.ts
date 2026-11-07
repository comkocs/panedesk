/** Trusted SDK dispatch keeps namespace ownership in the optional SDK registry. */
import type { Branded } from '@panedesk/dsh-brand'
import type { SeatName, SeatPrincipalId } from '@panedesk/dsh-seat'
import type { HostAdminEndpoint } from './index.ts'

export type { HostAdminSourceOperator, SourceOperatorItem, SourceOperatorWriteParams, SourceOperatorResult } from './source-operator.ts'

/** JSON values are the only SDK results admitted onto the administration wire. */
export type HostSdkJson = null | boolean | number | string | readonly HostSdkJson[] | { readonly [key: string]: HostSdkJson }
/** In-memory identity issued by the host, never decoded from request parameters. */
export interface HostSdkIdentity {
  principalId: SeatPrincipalId
  authorizationRef: Branded<'HostSdkAuthorizationRef'>
  sessionId?: Branded<'SessionId'>
  seat?: SeatName
  staffId?: string
  signal: AbortSignal
}
/** Registered namespace invocation, not an arbitrary built-in SDK command. */
export interface HostSdkInvocation { namespace: string; method: string; params: unknown }
/** Safe failure information is distinct from a namespace's successful JSON result. */
export type HostSdkResult = { status: 'ok'; value: HostSdkJson }
  | { status: 'rejected'; code: 'method-unavailable' | 'unauthorized' | 'invalid-params' | 'unavailable' }
/** The SDK registry provider supplies this optional adapter without starting stdio. */
export interface HostSdkInvoker {
  /** Decode, authorize, invoke and encode through the registered namespace.
   * @param request - Validated namespace and method with untrusted method parameters.
   * @param identity - Host-issued caller identity and revocation signal.
   * @returns Encoded result or safe rejection without provider diagnostics.
   */
  invoke(request: HostSdkInvocation, identity: HostSdkIdentity): Promise<HostSdkResult>
}
/** A binding's credentials belong to one live session and one process epoch. */
export interface HostSessionBinding {
  sessionId: NonNullable<HostSdkIdentity['sessionId']>
  seat: SeatName
  staffId?: string
}
/** Only paths leave the host when it prepares a session's tool environment. */
export interface HostSessionCredential {
  endpointPath: string
  credentialPath: string
  processEpoch: HostAdminEndpoint['processEpoch']
  /** Revoke before releasing session resources; admitted work observes cancellation. */
  revoke(): Promise<void>
}
/** Optional host-owned issuance; callers supply trusted creation facts, never wire fields. */
export interface HostSessionCredentials {
  /** Replace any earlier credential for this session and publish owner-only files.
   * @param binding - Trusted session creation binding.
   * @returns Paths and an idempotent awaited revocation capability.
   */
  issue(binding: HostSessionBinding): Promise<HostSessionCredential>
  /** Revoke a closed or replaced session before acknowledging closure.
   * @param sessionId - Host-owned session identity.
   */
  revoke(sessionId: HostSessionBinding['sessionId']): Promise<void>
}
declare module '@panedesk/cordis' {
  interface Context {
    /** Absent unless an SDK registry provider is installed. */
    hostSdkInvoker: HostSdkInvoker
    /** Absent when administration is disabled. */
    hostSessionCredentials: HostSessionCredentials
  }
}
