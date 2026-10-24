import { Context } from '@panedesk/cordis'
import type { AgentRegistry } from '@panedesk/dsh-agent'
import { brandString } from '@panedesk/dsh-brand'
import type { LlmRuntime } from '@panedesk/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import type { SdkMethodContext, SdkNamespaceRegistration } from '../src/method-registry.ts'
import Registry from '../src/registry-provider.ts'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

type Methods = { echo: { request: string; result: string } }
function registration() {
  return {
    namespace: 'example', version: '1',
    methods: { echo: {
      decodeRequest(value: unknown) {
        if (typeof value !== 'object' || value === null || !('text' in value) || typeof value.text !== 'string') throw new TypeError('text required')
        return value.text
      },
      encodeResult: (value: string) => ({ text: value }),
      invoke: vi.fn(async (value: string, _context: SdkMethodContext) => value),
    } },
    authorize: vi.fn<SdkNamespaceRegistration<Methods>['authorize']>(async () => ({ status: 'allowed' })),
  } satisfies SdkNamespaceRegistration<Methods>
}
const authority: SdkMethodContext = {
  principalId: brandString<SdkMethodContext['principalId']>('caller-a'),
  authorizationRef: brandString<SdkMethodContext['authorizationRef']>('authorization-a'),
  signal: new AbortController().signal,
}

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(Registry)
  ctx.provide('llm', { listProviders: () => [{ id: 'fixture' }], resolveCallConfig: async () => ({}) } as Partial<LlmRuntime> as LlmRuntime)
  ctx.provide('agents', { currentInitiator: () => undefined } as Partial<AgentRegistry> as AgentRegistry)
  const server = new HarnessSdkJsonRpcServer(ctx, { notify() {}, request: async () => ({}) })
  return { ctx, server, registry: ctx.sdkMethods }
}

describe('SDK namespace registry', () => {
  it('advertises active versions and dispatches only after initialization without trusting parameters', async () => {
    const f = await fixture(), r = registration()
    try {
      f.registry.register(r)
      await expect(f.server.handleRequest('example/echo', { text: 'before' })).rejects.toMatchObject({ data: { reason: 'method-unavailable' } })
      expect(await f.server.initialize({ cwd: process.cwd(), provider: 'fixture', model: 'fixture' })).toMatchObject({ namespaces: [{ namespace: 'example', version: '1' }] })
      await expect(f.server.handleRequest('example/echo', { text: 'hello', principalId: 'forged', authorizationRef: 'forged' })).resolves.toEqual({ text: 'hello' })
      expect(r.methods.echo.invoke).toHaveBeenCalledTimes(1)
      const context = r.methods.echo.invoke.mock.calls[0]?.[1]
      if (context === undefined) throw new Error('Missing invocation context')
      expect(typeof context.principalId).toBe('string')
      expect(typeof context.authorizationRef).toBe('string')
      expect(context.principalId).not.toBe('forged')
      expect(context.authorizationRef).not.toBe('forged')
      expect(context.sessionId).toBeUndefined()
      await expect(f.server.handleRequest('example/missing', {})).rejects.toMatchObject({ data: { reason: 'method-unavailable' } })
      await expect(f.server.handleRequest('missing/echo', {})).rejects.toMatchObject({ data: { reason: 'method-unavailable' } })
    } finally { await f.server.shutdown(); await f.ctx.fiber.dispose() }
  })

  it('rejects duplicate and reserved namespaces without replacing active methods', async () => {
    const f = await fixture(), r = registration()
    try {
      const dispose = f.registry.register(r)
      expect(() => f.registry.register(registration())).toThrow('unavailable')
      for (const namespace of ['session', 'seats', 'messages', 'initialize', 'shutdown']) {
        expect(() => f.registry.register({ ...registration(), namespace })).toThrow('unavailable')
      }
      expect(() => f.registry.register({ ...registration(), namespace: 'invalid/name' })).toThrow('unavailable')
      expect(() => f.registry.register({ ...registration(), namespace: 'failed', version: '' })).toThrow('unavailable')
      await expect(f.registry.dispatch('failed/echo', { text: 'late' }, authority)).rejects.toMatchObject({ data: { reason: 'method-unavailable' } })
      expect(await f.registry.dispatch('example/echo', { text: 'original' }, authority)).toEqual({ text: 'original' })
      await dispose()
      expect(f.registry.capabilities()).toEqual([])
      await expect(f.registry.dispatch('example/echo', { text: 'late' }, authority)).rejects.toMatchObject({ data: { reason: 'method-unavailable' } })
    } finally { await f.server.shutdown(); await f.ctx.fiber.dispose() }
  })

  it('decodes before authorization and never invokes rejected work', async () => {
    const f = await fixture(), r = registration()
    r.authorize = vi.fn(async () => ({ status: 'rejected', code: 'unauthorized', reason: 'private diagnostic' }))
    try {
      f.registry.register(r)
      await expect(f.registry.dispatch('example/echo', {}, authority)).rejects.toThrow('text required')
      expect(r.authorize).not.toHaveBeenCalled()
      await expect(f.registry.dispatch('example/echo', { text: 'denied' }, authority)).rejects.toMatchObject({ data: { reason: 'unauthorized' } })
      expect(r.methods.echo.invoke).not.toHaveBeenCalled()
    } finally { await f.server.shutdown(); await f.ctx.fiber.dispose() }
  })

  it('aborts admitted extension work during shutdown and refuses later calls', async () => {
    const f = await fixture(), r = registration()
    const admitted = Promise.withResolvers<undefined>(), settle = Promise.withResolvers<string>()
    let signal: AbortSignal | undefined
    r.methods.echo.invoke.mockImplementation(async (_request, context) => {
      signal = context.signal; admitted.resolve(undefined); return settle.promise
    })
    try {
      f.registry.register(r)
      await f.server.initialize({ cwd: process.cwd(), provider: 'fixture', model: 'fixture' })
      const call = f.server.handleRequest('example/echo', { text: 'pending' })
      await admitted.promise
      let stopped = false
      const stopping = f.server.shutdown().then(() => { stopped = true })
      expect(signal?.aborted).toBe(true)
      expect(stopped).toBe(false)
      await expect(f.server.handleRequest('example/echo', { text: 'late' })).rejects.toMatchObject({ data: { reason: 'method-unavailable' } })
      settle.resolve('done')
      await call
      await stopping
      expect(stopped).toBe(true)
    } finally { settle.resolve('done'); await f.server.shutdown(); await f.ctx.fiber.dispose() }
  })

  it('removes contributions on fiber disposal and drains admitted work before releasing the owner', async () => {
    const f = await fixture(), r = registration()
    const admitted = Promise.withResolvers<undefined>(), settle = Promise.withResolvers<string>()
    r.methods.echo.invoke.mockImplementation(async () => { admitted.resolve(undefined); return settle.promise })
    const owner = await f.ctx.plugin((ctx) => { ctx.get('sdkMethods')!.register(r) })
    try {
      const call = f.registry.dispatch('example/echo', { text: 'pending' }, authority)
      await admitted.promise
      let disposed = false
      const disposing = owner.dispose().then(() => { disposed = true })
      await vi.waitFor(() => { expect(f.registry.capabilities()).toEqual([]) })
      expect(disposed).toBe(false)
      settle.resolve('done')
      await expect(call).resolves.toEqual({ text: 'done' })
      await disposing
      expect(disposed).toBe(true)
    } finally { settle.resolve('done'); await owner.dispose(); await f.server.shutdown(); await f.ctx.fiber.dispose() }
  })
})
