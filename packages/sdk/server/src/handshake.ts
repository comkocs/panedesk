/** Wire validation for optional SDK policy and attribution inputs. */
import { createHash } from 'node:crypto'
import type { InitializeParams } from '@panedesk/dsh-sdk-protocol'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Hash installed policy JSON with recursively sorted object keys and ordered arrays.
 * @param value - locally resolved JSON policy, including its rules digest.
 * @returns lower-case SHA-256 digest.
 */
export function executionPolicyDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical)
    if (object(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]))
    return item
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function strings(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new TypeError(`initialize ${key} must be a non-empty string`)
    }
  }
}

/** Validate untrusted initialize fields before resolving any local capabilities.
 * @param params - request decoded from the SDK transport.
 */
export function validateHandshake(params: InitializeParams): void {
  if (!object(params)) throw new TypeError('initialize requires an object')
  strings(params, ['cwd', 'provider', 'model'])
  if (params.messagesVersion !== undefined && (!Number.isSafeInteger(params.messagesVersion) || params.messagesVersion <= 0)) {
    throw new TypeError('initialize messagesVersion must be a positive safe integer')
  }
  if (params.agentPreset !== undefined) strings(params, ['agentPreset'])
  if (params.executionPolicy !== undefined) {
    if (!object(params.executionPolicy)) throw new TypeError('initialize executionPolicy requires an object')
    strings(params.executionPolicy, ['presetId', 'version', 'digest'])
    if (params.agentPreset !== params.executionPolicy.presetId
      || !/^[a-f0-9]{64}$/.test(params.executionPolicy.digest)) {
      throw new TypeError('initialize executionPolicy must match agentPreset and a SHA-256 digest')
    }
  }
  if (params.ledgerContext !== undefined) {
    const context = params.ledgerContext
    if (!object(context)) throw new TypeError('initialize ledgerContext requires an object')
    strings(context, ['seat', 'window', 'nodeId', 'parentSessionId', 'rootSessionId', 'subagentRunId', 'parentRunId', 'childSessionId'])
    if (!['startup', 'environment', 'settings', 'inherited', 'free'].includes(context.identitySource)) {
      throw new TypeError('initialize ledgerContext has an invalid identitySource')
    }
    for (const key of ['taskId', 'accountLabel']) if (context[key] !== undefined) strings(context, [key])
    if (context.deliveryPaths !== undefined && (!Array.isArray(context.deliveryPaths)
      || !context.deliveryPaths.every(path => typeof path === 'string' && path.length > 0))) {
      throw new TypeError('initialize deliveryPaths must contain non-empty strings')
    }
  }
  if (params.cachePolicy !== undefined) {
    if (!object(params.cachePolicy)
      || !['default', 'none', '5m', '1h', '30m', '12h', 'auto'].includes(params.cachePolicy.retention)) {
      throw new TypeError('initialize cachePolicy has an invalid retention')
    }
    if (params.cachePolicy.key !== undefined) strings(params.cachePolicy, ['key'])
  }
}
