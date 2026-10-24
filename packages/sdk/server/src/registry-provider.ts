/** Effect-scoped SDK namespaces with authorization and quiescent removal. */
import { Service, type Context } from '@panedesk/cordis'
import { brandString } from '@panedesk/dsh-brand'
import type { HostSdkInvoker } from '@panedesk/dsh-host-admin'
import { isMessagesMethod, isSeatMethod, JsonRpcResponseError } from '@panedesk/dsh-sdk-protocol'
import type {
  SdkExtensionJson, SdkMethodContext, SdkMethodRegistry, SdkNamespaceCapability, SdkNamespaceRegistration,
} from './method-registry.ts'

interface Entry {
  capability: SdkNamespaceCapability
  calls: Set<Promise<SdkExtensionJson>>
  invoke(method: string, params: unknown, context: SdkMethodContext): Promise<SdkExtensionJson>
}

function unavailable(): JsonRpcResponseError {
  return new JsonRpcResponseError(-32601, 'SDK method is unavailable', { reason: 'method-unavailable' })
}

function reserved(namespace: string): boolean {
  return ['initialize', 'shutdown', 'session', 'seats', 'messages', 'nodes', 'authorizations'].includes(namespace)
}

/** Registry provider; mounting it alone does not start a transport or an agent. */
export default class SdkMethodRegistryProvider extends Service implements SdkMethodRegistry {
  private readonly entries = new Map<string, Entry>()

  constructor(ctx: Context) {
    super(ctx, 'sdkMethods')
    const invoker: HostSdkInvoker = { invoke: async (request, identity) => {
      if (identity.signal.aborted) return { status: 'rejected', code: 'unauthorized' }
      try {
        const value = await this.dispatch(`${request.namespace}/${request.method}`, request.params, {
          principalId: brandString<SdkMethodContext['principalId']>(identity.principalId),
          authorizationRef: brandString<SdkMethodContext['authorizationRef']>(identity.authorizationRef),
          signal: identity.signal,
          ...(identity.sessionId === undefined ? {} : { sessionId: identity.sessionId }),
          ...(identity.seat === undefined ? {} : { seat: identity.seat }),
          ...(identity.staffId === undefined ? {} : { staffId: identity.staffId }),
        })
        return { status: 'ok', value }
      } catch (error) {
        if (error instanceof JsonRpcResponseError) {
          if (error.code === -32601) return { status: 'rejected', code: 'method-unavailable' }
          if (error.code === -32602) return { status: 'rejected', code: 'invalid-params' }
          return { status: 'rejected', code: 'unauthorized' }
        }
        return { status: 'rejected', code: 'unavailable' }
      }
    } }
    ctx.provide('hostSdkInvoker', invoker)
  }

  register<Methods extends { [K in keyof Methods]: { request: unknown; result: unknown } }>(
    registration: SdkNamespaceRegistration<Methods>,
  ): () => Promise<void> {
    const { namespace, version } = registration
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(namespace) || reserved(namespace)
      || version.trim().length === 0 || this.entries.has(namespace)) {
      throw unavailable()
    }
    const methods = { ...registration.methods }
    for (const method of Object.keys(methods)) {
      if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(method)
        || isSeatMethod(`${namespace}/${method}`) || isMessagesMethod(`${namespace}/${method}`)) throw unavailable()
    }
    const authorize = registration.authorize.bind(registration)
    const entry: Entry = {
      capability: Object.freeze({ namespace, version }),
      calls: new Set(),
      async invoke(method, params, context) {
        if (!Object.hasOwn(methods, method)) throw unavailable()
        const key = method as keyof Methods & string
        const definition = methods[key]
        const request = definition.decodeRequest(params)
        const admission = await authorize(context, key, request)
        if (context.signal.aborted) throw new JsonRpcResponseError(-32603, 'SDK caller was revoked', { reason: 'unauthorized' })
        if (admission.status === 'rejected') {
          throw new JsonRpcResponseError(admission.code === 'unauthorized' ? -32603 : -32601,
            'SDK method authorization rejected', { reason: admission.code })
        }
        return definition.encodeResult(await definition.invoke(request, context))
      },
    }
    this.entries.set(namespace, entry)
    let draining: Promise<void> | undefined
    const remove = (): Promise<void> => {
      if (this.entries.get(namespace) === entry) this.entries.delete(namespace)
      draining ??= Promise.allSettled([...entry.calls]).then(() => undefined)
      return draining
    }
    try { this.ctx.effect(() => remove, `sdk.namespace.${namespace}`) } catch (error) {
      this.entries.delete(namespace)
      throw error
    }
    return remove
  }

  capabilities(): readonly SdkNamespaceCapability[] {
    return Object.freeze([...this.entries.values()].map(entry => entry.capability))
  }

  async dispatch(method: string, params: unknown, context: SdkMethodContext): Promise<SdkExtensionJson> {
    const separator = method.indexOf('/')
    const entry = this.entries.get(method.slice(0, separator))
    if (separator <= 0 || entry === undefined) throw unavailable()
    const call = entry.invoke(method.slice(separator + 1), params, context)
    entry.calls.add(call)
    try { return await call } finally { entry.calls.delete(call) }
  }
}
