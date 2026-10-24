/** Optional SDK namespace definitions; fixed dispatch remains owned by the server. */
import type { Context } from '@panedesk/cordis'
import type { Branded } from '@panedesk/dsh-brand'
import type { SessionId } from '@panedesk/dsh-session'

/** JSON-only extension results keep credentials and live host objects off the wire. */
export type SdkExtensionJson = null | boolean | number | string | readonly SdkExtensionJson[] | { readonly [key: string]: SdkExtensionJson }
/** Host-resolved identity is never decoded from extension request parameters. */
export interface SdkMethodContext {
  principalId: Branded<'SdkPrincipalId'>
  sessionId?: SessionId
  authorizationRef: Branded<'SdkAuthorizationRef'>
  signal: AbortSignal
}
/** A rejected authorization produces no invocation or side effect. */
export type SdkMethodAuthorization = { status: 'allowed' } | { status: 'rejected'; code: 'unauthorized' | 'method-unavailable'; reason: string }
/** Decode precedes authorization; invocation only receives a validated request. */
export interface SdkMethodDefinition<Request, Result> {
  /** Validate bounded wire parameters without deriving authority.
   * @param value - Untrusted JSON parameters.
   * @returns Decoded input; malformed input throws before invocation.
   */
  decodeRequest(value: unknown): Request
  /** Serialize only the method's declared public result fields.
   * @param value - Provider result.
   * @returns JSON without host identities or credentials not intended for the caller.
   */
  encodeResult(value: Result): SdkExtensionJson
  /** Execute under authenticated invocation-local authority.
   * @param request - Decoded method input.
   * @param context - Host-owned authenticated identity and cancellation.
   * @returns The provider result without transport framing.
   */
  invoke(request: Request, context: SdkMethodContext): Promise<Result>
}
/** A typed method map retains request/result correlation at registration. */
export type SdkMethodDefinitions<Methods extends { [K in keyof Methods]: { request: unknown; result: unknown } }> = {
  readonly [K in keyof Methods]: SdkMethodDefinition<Methods[K]['request'], Methods[K]['result']>
}
/** Namespace ownership is exclusive; built-in method names cannot be shadowed. */
export interface SdkNamespaceRegistration<Methods extends { [K in keyof Methods]: { request: unknown; result: unknown } }> {
  namespace: string
  version: string
  methods: SdkMethodDefinitions<Methods>
  /** Check the authenticated caller against the decoded method and request.
   * @param context - Host-resolved caller.
   * @param method - Exact registered method name.
   * @param request - Decoded input corresponding to that method.
   * @returns Admission or a safe rejection without invoking the method.
   */
  authorize<K extends keyof Methods & string>(context: SdkMethodContext, method: K, request: Methods[K]['request']): Promise<SdkMethodAuthorization>
}
/** Handshakes advertise only namespaces whose registrations remain active. */
export interface SdkNamespaceCapability { namespace: string; version: string }
/** Optional provider definition; declaring it does not enable third-party dispatch. */
export interface SdkMethodRegistry {
  /** Install one namespace through the caller's Cordis effect scope.
   * @param registration - Exclusive namespace and bounded codecs.
   * @returns Disposer that drains admitted work and makes later calls method-unavailable.
   */
  register<Methods extends { [K in keyof Methods]: { request: unknown; result: unknown } }>(
    registration: SdkNamespaceRegistration<Methods>,
  ): () => Promise<void>
  /** Report currently callable namespace versions after initialization.
   * @returns An immutable capability snapshot, excluding disposed registrations.
   */
  capabilities(): readonly SdkNamespaceCapability[]
}

declare module '@panedesk/cordis' {
  interface Context {
    /** Optional extension registry; consumers use ctx.get and preserve fixed dispatch when absent. */
    sdkMethods: SdkMethodRegistry
  }
}

/** Optional host lookup type never installs a registry as an import side effect. */
export type SdkMethodRegistryContext = Pick<Context, 'sdkMethods'>
