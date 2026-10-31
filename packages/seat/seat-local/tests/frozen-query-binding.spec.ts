/** Frozen receipt reads bind live callers to the complete retained seat and task scope. */
import { expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { frozenHost, sender, principalId } from './frozen-fixture.ts'
import { digest } from '../src/store.ts'

const methods = ['engine.acceptFrozen', 'seat.openFrozen', 'seat.wakeFrozen'] as const
const tasks = ['task-a', 'task-b'] as T.SeatTaskId[]
for (const phase of ['query', 'write'] as const)
  for (const [method, existing] of [...methods.map(method => [method, false] as const), ['seat.wakeFrozen', true] as const]) {
    test.each(['principal', 'node', 'seat', 'tasks'] as const)(`${method} ${phase} existing=${existing} rejects a live grant with mismatched %s without exposing a receipt`, async (binding) => {
      const { h, registry, request } = await frozenHost()
      const disposers: (() => void | Promise<void>)[] = []
      try {
        await registry.ready(methods)
        const operationId = `query-binding:${method}` as T.SeatOperationId
        const base = request(operationId)
        base.openingContext.snapshot.taskIds = tasks
        base.openingContext.scopeReservation.taskIds = tasks
        if (existing) {
          const catalog = await h.seats.definitions({}), definition = catalog.definitions[0]!
          await h.seats.save({ definition: { ...definition, wakeTemplate: { kind: 'text', text: 'Bound wake' } },
            expectedRevision: catalog.revision, operationId: 'bound-wake-template' as T.SeatOperationId })
          const contexts = h.ctx.get('seatOpeningContexts')!, snapshot = base.openingContext.snapshot
          disposers.push(contexts.register({ providerId: snapshot.reference.providerId, resolve: async () => snapshot }))
          expect(await contexts.open({ seat: base.request.seat, operationId: 'bound-existing' as T.SeatOperationId,
            origin: 'manual', openingMode: 'prefill', openingContext: snapshot.reference, relatedTaskIds: tasks }, h.authority))
            .toMatchObject({ status: 'prefilled' })
          await vi.waitFor(async () => {
            expect((await h.state.read()).effects.some(effect => effect.kind === 'callback/delivered')).toBe(true)
          })
        }
        const payload: T.AcceptFrozenTriggerRequest | T.OpenFrozenSeatRequest | T.WakeFrozenSeatRequest = method === 'engine.acceptFrozen' ? {
          envelope: { sourceId: base.route.sourceId, triggerId: 'query-trigger' as T.TriggerId,
            kind: 'external' as const, seat: base.request.seat, projectId: h.definition.projectId,
            receivedAt: new Date().toISOString(), evidence: { kind: 'external' as const, eventType: 'query-event' },
            eventId: 'query-event' as T.SourceEventId, callbackRef: base.route.sourceId,
            data: 'Query binding', dataDigest: digest('Query binding') },
          route: { ...base.route, triggerId: 'query-trigger' as T.TriggerId },
          openingContext: base.openingContext, expectedSeatRevision: base.expectedSeatRevision,
        } : method === 'seat.openFrozen' ? base : { ...base, request: { seat: base.request.seat, operationId } }
        const issue = async (input: object, damage?: typeof binding): Promise<T.SeatCallContext> => {
          const issuer = h.engine.authorizationIssuers.register({ identity: { kind: 'node-delegation', principalId,
            nodeId: h.options.nodeId, sourceNodeId: sender, origin: 'remote',
            seat: damage === 'seat' ? 'other-seat' as T.SeatName : base.request.seat,
            taskIds: damage === 'tasks' ? tasks.slice(0, 1) : tasks, policyRevision: 1 },
          current: () => ({ decision: 'allowed', reasonCode: 'allowed', policyRevision: 1 }) })
          disposers.push(() => { issuer.dispose() })
          const authorization = await issuer.issuer.check({ operationId, requestDigest: digest(input) })
          if ('status' in authorization) throw new Error('Expected live query authority')
          expect(h.engine.authorizationIssuers.verify(authorization,
            { operationId, requestDigest: digest(input) }, h.options.nodeId)).toEqual(authorization.fact)
          return { principalId: damage === 'principal' ? 'other-principal' as T.SeatPrincipalId : principalId,
            nodeId: damage === 'node' ? 'other-node' as T.SeatNodeId : h.options.nodeId, origin: 'remote', authorization }
        }
        const authority = await issue(payload, phase === 'write' ? binding : undefined)
        const beforeWrite = await h.state.read(), sessionsBeforeWrite = await h.ctx.sessionPersistence.list()
        const sendWrite = vi.spyOn(h.ctx.get('messageDelivery')!, 'send')
        const admitted = 'envelope' in payload ? await h.engine.acceptFrozen(payload, authority)
          : method === 'seat.openFrozen' ? await h.ctx.get('seats')!.withAuthority(authority).openFrozen!(payload as T.OpenFrozenSeatRequest)
            : await h.ctx.get('seats')!.withAuthority(authority).wakeFrozen!(payload)
        if (phase === 'write') {
          const message = binding === 'principal' || binding === 'node'
            ? `Frozen admission requires authenticated sending-node attribution${method === 'engine.acceptFrozen' ? '' : '.'}`
            : method === 'seat.wakeFrozen' && binding === 'seat' ? 'Wake input does not match its authorized target'
              : 'Frozen operation requires matching live authority'
          const refusal = method === 'seat.wakeFrozen' && !existing && binding === 'tasks'
            && admitted.status === 'opened' && 'result' in admitted ? admitted.result : admitted
          expect(refusal).toMatchObject({ status: 'rejected', error: { code: 'unauthorized', message, effectState: 'none' } })
          expect(await h.state.read()).toEqual(beforeWrite)
          expect(await h.ctx.sessionPersistence.list()).toEqual(sessionsBeforeWrite)
          expect(sendWrite).not.toHaveBeenCalled()
          expect(h.adapter.requests).toEqual([])
          return
        }
        sendWrite.mockRestore()
        expect(admitted).toMatchObject(method === 'engine.acceptFrozen' ? { status: 'accepted' }
          : method === 'seat.openFrozen' ? { status: 'queued' } : existing ? { status: 'sent' } : { status: 'opened', result: { status: 'queued' } })
        const query: T.NodeWorkChainOperationRequest = { key: { sourceNodeId: sender, principalId,
          sourceId: base.route.sourceId, ownerEpoch: base.route.ownerEpoch, method, operationId }, payloadDigest: digest(payload) }
        expect(await registry.query(query, await issue(query))).toMatchObject({ status: 'settled', method })
        const before = await h.state.read(), sessions = await h.ctx.sessionPersistence.list()
        const send = vi.spyOn(h.ctx.get('messageDelivery')!, 'send')
        const result = await registry.query(query, await issue(query, binding))
        const message = method === 'engine.acceptFrozen' ? 'Frozen query attribution does not match'
          : method === 'seat.wakeFrozen' && (binding === 'principal' || binding === 'node' || existing)
            ? 'Wake query attribution does not match' : 'Frozen query attribution does not match.'
        expect(result).toMatchObject({ status: 'rejected', error: { code: 'unauthorized', message, effectState: 'none' } })
        expect(await h.state.read()).toEqual(before)
        expect(await h.ctx.sessionPersistence.list()).toEqual(sessions)
        expect(send).not.toHaveBeenCalled()
        expect(h.adapter.requests).toEqual([])
      } finally { for (const dispose of disposers) await dispose(); vi.restoreAllMocks(); await h.close() }
    })
  }
