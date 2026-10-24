/** SDK host queries preserve provider watermarks and distinguish stale nodes from absence. */
import type { HostProjectionMethods } from '@panedesk/dsh-sdk-jsonrpc-server'
import { SdkProtocolError } from './client.ts'

/** Provider-owned node and authorization request/result pairs. */
export type HostQueryMethods = HostProjectionMethods
/** Additive handshake data; absent namespaces mean no extensions were advertised. */
export interface SdkNamespaceCapability { namespace: string; version: string }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate advertised namespaces without adding private SDK properties.
 * @param value - Untrusted optional handshake field.
 * @returns Copied namespace versions, or undefined for a legacy handshake.
 */
export function decodeNamespaces(value: unknown): readonly SdkNamespaceCapability[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new SdkProtocolError('Invalid SDK namespace capabilities')
  const names = new Set<string>()
  return value.map((item: unknown) => {
    if (!object(item) || typeof item.namespace !== 'string' || item.namespace.length === 0
      || typeof item.version !== 'string' || item.version.length === 0 || names.has(item.namespace)) {
      throw new SdkProtocolError('Invalid SDK namespace capability')
    }
    names.add(item.namespace)
    return { namespace: item.namespace, version: item.version }
  })
}

function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function cursor(value: unknown): boolean {
  return object(value) && text(value.nodeId) && integer(value.sequence) && integer(value.effectIndex)
}
function failure(value: unknown): boolean {
  return object(value) && text(value.code) && text(value.message) && text(value.alternative)
    && typeof value.retryable === 'boolean' && ['none', 'committed', 'partial', 'unknown'].includes(String(value.effectState))
}
function fact(value: unknown): boolean {
  return object(value) && ['authorizationId', 'principalId', 'nodeId', 'operationId', 'reasonCode', 'requestDigest', 'checkedAt'].every(key => text(value[key]))
    && ['model-tool-call', 'human', 'engine', 'local-operator', 'node-delegation'].includes(String(value.kind))
    && ['manual', 'remote', 'engine'].includes(String(value.origin))
    && ['allowed', 'denied'].includes(String(value.decision)) && integer(value.policyRevision)
    && Array.isArray(value.taskIds) && value.taskIds.every(text)
    && ['sessionId', 'seat', 'callId', 'rootCallId', 'delegatedBy'].every(key => value[key] === undefined || text(value[key]))
}
function authorizationPage(value: unknown): value is HostQueryMethods['authorizations/query']['result'] {
  return object(value) && (value.status === 'rejected' ? failure(value.error)
    : Array.isArray(value.facts) && value.facts.every(fact)
    && typeof value.complete === 'boolean' && integer(value.watermark)
    && (value.nextCursor === undefined || cursor(value.nextCursor))
    && ['legacy-unknown', 'none'].includes(String(value.legacyAttribution)))
}
function capacity(value: unknown): boolean {
  return object(value) && text(value.nodeId) && text(value.nodeName)
    && ['running', 'recovering', 'unavailable'].includes(String(value.engine))
    && integer(value.openEngineWindows) && (value.limit === null || integer(value.limit))
    && (value.readyAt === null || text(value.readyAt))
}
function node(value: unknown): boolean {
  return object(value) && text(value.nodeId) && text(value.nodeName)
    && typeof value.reachable === 'boolean' && typeof value.observedAt === 'string'
    && ['connected', 'disconnected', 'connecting', 'stale'].includes(String(value.linkState))
    && Array.isArray(value.capabilities) && value.capabilities.every(item => typeof item === 'string')
    && (value.safeReason === null || typeof value.safeReason === 'string')
    && (value.status === null || capacity(value.status))
}

/** Transport-neutral host facade; it never launches a second host or retries a scan.
 * @param request - Existing authenticated SDK request transport.
 */
export class HostClient {
  constructor(private readonly request: (method: string, params: object) => Promise<unknown>) {}

  /** List dated node health, including unreachable entries.
   * @returns Provider health records without synthesizing capacity.
   */
  async listNodes(): Promise<HostQueryMethods['nodes/list']['result']> {
    const result = await this.request('nodes/list', {})
    if (!Array.isArray(result) || !result.every(node)) throw new SdkProtocolError('Invalid node list')
    return result as HostQueryMethods['nodes/list']['result']
  }

  /** Read one node alias; absent aliases return null rather than zero windows.
   * @param nodeId - Exact configured node alias.
   * @returns Dated health or null.
   */
  async nodeStatus(nodeId: string): Promise<HostQueryMethods['nodes/status']['result']> {
    if (nodeId.trim().length === 0) throw new TypeError('nodeId is required')
    const result = await this.request('nodes/status', { nodeId })
    if (result !== null && !node(result)) throw new SdkProtocolError('Invalid node status')
    return result as HostQueryMethods['nodes/status']['result']
  }

  /** Query committed authorization evidence, not reusable authority.
   * @param request - Task, seat, kind and exclusive cursor filters.
   * @returns Unmodified pagination, including an advancing empty page.
   */
  async queryAuthorizations(request: HostQueryMethods['authorizations/query']['request']): Promise<HostQueryMethods['authorizations/query']['result']> {
    const result = await this.request('authorizations/query', request)
    if (!authorizationPage(result)) throw new SdkProtocolError('Invalid authorization query result')
    return result
  }
}
