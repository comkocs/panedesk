/** Business-owner declarations remain usable without installing a registry implementation. */
import { readFileSync } from 'node:fs'
import type { Context, Disposable } from '@panedesk/cordis'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  NodeWorkChainBusinessMethod, NodeWorkChainBusinessProvider, NodeWorkChainBusinessRegistry,
  NodeWorkChainMethod, NodeWorkChainOperationRequest, NodeWorkChainOperationResult, SeatCallContext,
} from '../src/index.ts'
import type { NodeWorkChainBusinessProvider as DirectProvider } from '../src/types.ts'

describe('chain business declarations', () => {
  it('exports six business methods and authenticated exact-query signatures', () => {
    expectTypeOf<NodeWorkChainBusinessMethod>().toEqualTypeOf<Exclude<NodeWorkChainMethod, 'chain.operation' | 'seat.definitionRevision'>>()
    expectTypeOf<Extract<NodeWorkChainBusinessMethod, 'chain.operation'>>().toEqualTypeOf<never>()
    expectTypeOf<NodeWorkChainBusinessProvider>().toEqualTypeOf<DirectProvider>()
    expectTypeOf<NodeWorkChainBusinessProvider['methods']>().toEqualTypeOf<readonly NodeWorkChainBusinessMethod[]>()
    expectTypeOf<NodeWorkChainBusinessProvider['ready']>().toEqualTypeOf<() => Promise<void>>()
    expectTypeOf<NodeWorkChainBusinessProvider['query']>().toEqualTypeOf<
      (request: NodeWorkChainOperationRequest, context: SeatCallContext) => Promise<NodeWorkChainOperationResult>
    >()
    expectTypeOf<NonNullable<NodeWorkChainBusinessProvider['resume']>>().toEqualTypeOf<NodeWorkChainBusinessProvider['query']>()
    expectTypeOf<NodeWorkChainBusinessProvider['resume']>().toBeNullable()
    const methods = [
      'engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen',
      'source.prepareOpening', 'source.checkAdmission', 'source.deliverCallback',
    ] as const satisfies readonly NodeWorkChainBusinessMethod[]
    expectTypeOf<typeof methods[number]>().toEqualTypeOf<NodeWorkChainBusinessMethod>()
    expect(new Set(methods).size).toBe(6)
  })

  it('exports the optional Cordis registry with disposer and aggregate recovery signatures', () => {
    expectTypeOf<Context['nodeWorkChainBusiness']>().toEqualTypeOf<NodeWorkChainBusinessRegistry>()
    expectTypeOf<NodeWorkChainBusinessRegistry['register']>().toEqualTypeOf<
      (provider: NodeWorkChainBusinessProvider) => Disposable
    >()
    expectTypeOf<NodeWorkChainBusinessRegistry['resolve']>().toEqualTypeOf<
      (method: NodeWorkChainBusinessMethod) => NodeWorkChainBusinessProvider | undefined
    >()
    expectTypeOf<NodeWorkChainBusinessRegistry['ready']>().toEqualTypeOf<
      (methods: readonly NodeWorkChainBusinessMethod[]) => Promise<void>
    >()
  })

  it('documents duplicate-method rejection without pretending to implement the registry', () => {
    const declarations = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    expect(declarations).toContain('@throws If any method already has a provider, including registration of the same provider again; no partial registration is allowed.')
    expect(readme).toContain('Each method has one provider globally; overlapping or repeated registration throws without partial registration.')
    expect(readme).toContain('before it resolves, queries return only pending/unknown, never missing')
    expect(readme).toContain('Optional resume reauthorizes the restricted outbox identity, retains the original key and digest')
  })
})
