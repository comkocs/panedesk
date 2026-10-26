/** Trusted source attribution and owner declarations leave legacy callers unchanged. */
import { readFileSync } from 'node:fs'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  SeatAuthorizationEntry, SeatAuthorizationFact, SeatIssuedAuthorizationFact,
  SeatNodeId, SeatOpeningContexts, SeatSourceOwner,
} from '../src/index.ts'
import type { SeatSourceOwner as DirectOwner, SeatLocalCallbackOwner as DirectCallbackOwner } from '../src/types.ts'
import { Context } from '@panedesk/cordis'
import type { SeatLocalCallbackOwner, SeatCallbackAttemptResult, SeatCallbackDiagnostic, SeatCallbackDelivery,
  NodeWorkChainOperationRequest, NodeWorkChainOperationResult, DeliverSourceCallbackRequest,
  DeliverSourceCallbackResult, NodeWorkChainOperationKey } from '../src/index.ts'

describe('chain context declarations', () => {
  it('exports the optional local callback owner and leaves it unprovided', async () => {
    expectTypeOf<SeatLocalCallbackOwner>().toEqualTypeOf<DirectCallbackOwner>()
    expectTypeOf<SeatLocalCallbackOwner['query']>().toEqualTypeOf<
      (request: NodeWorkChainOperationRequest) => Promise<SeatCallbackAttemptResult<NodeWorkChainOperationResult>>>()
    expectTypeOf<SeatLocalCallbackOwner['deliver']>().toEqualTypeOf<
      (request: DeliverSourceCallbackRequest, key: NodeWorkChainOperationKey) =>
      Promise<SeatCallbackAttemptResult<DeliverSourceCallbackResult>>>()
    expectTypeOf<SeatCallbackDelivery['lastDiagnostic']>().toEqualTypeOf<SeatCallbackDiagnostic | undefined>()
    const ctx = new Context()
    try { expect(ctx.get('seatLocalCallbackOwner')).toBeUndefined() } finally { await ctx.fiber.dispose() }
  })

  it('carries optional authenticated source identity through issued facts and entry identity', () => {
    expectTypeOf<SeatAuthorizationFact['sourceNodeId']>().toEqualTypeOf<SeatNodeId | undefined>()
    expectTypeOf<SeatIssuedAuthorizationFact['sourceNodeId']>().toEqualTypeOf<SeatNodeId | undefined>()
    expectTypeOf<SeatAuthorizationEntry['identity']['sourceNodeId']>().toEqualTypeOf<SeatNodeId | undefined>()
    expectTypeOf<Omit<SeatAuthorizationFact, 'sourceNodeId'>>().toExtend<SeatAuthorizationFact>()
    expectTypeOf<Omit<SeatIssuedAuthorizationFact, 'sourceNodeId'>>().toExtend<SeatIssuedAuthorizationFact>()
    expectTypeOf<Omit<SeatAuthorizationEntry['identity'], 'sourceNodeId'>>().toExtend<SeatAuthorizationEntry['identity']>()
  })

  it('requires all owner methods with the existing optional hook signatures', () => {
    expectTypeOf<SeatSourceOwner>().toEqualTypeOf<DirectOwner>()
    expectTypeOf<SeatSourceOwner>().toEqualTypeOf<Required<Pick<SeatOpeningContexts, 'prepare' | 'checkAdmission' | 'deliverCallback'>>>()
    expectTypeOf<SeatSourceOwner['prepare']>().toEqualTypeOf<NonNullable<SeatOpeningContexts['prepare']>>()
    expectTypeOf<SeatSourceOwner['checkAdmission']>().toEqualTypeOf<NonNullable<SeatOpeningContexts['checkAdmission']>>()
    expectTypeOf<SeatSourceOwner['deliverCallback']>().toEqualTypeOf<NonNullable<SeatOpeningContexts['deliverCallback']>>()
    expectTypeOf<NonNullable<SeatOpeningContexts['registerSourceOwner']>>().toEqualTypeOf<(owner: SeatSourceOwner) => () => Promise<void>>()
    expectTypeOf<Omit<SeatOpeningContexts, 'registerSourceOwner'>>().toExtend<SeatOpeningContexts>()
    expectTypeOf<SeatOpeningContexts['registerSourceOwner']>().toBeNullable()
  })

  it('documents exclusive registration and draining without implementing the owner', () => {
    const declarations = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    expect(declarations).toContain('@throws If a source owner is already registered, including the same owner again.')
    expect(declarations).toContain('Disposer that stops new calls and drains in-flight calls before removing the owner.')
    expect(readme).toContain('Without a registered owner, providers do not expose these three methods')
    expect(readme).toContain('never from request JSON')
  })
})
