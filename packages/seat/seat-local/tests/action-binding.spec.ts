/** Local action callers cannot substitute another live grant's identity or window scope. */
import { expect, test, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { engineFixture } from './engine-fixture.ts'
import { operation } from './fixtures.ts'
import { LocalSeatService } from '../src/service.ts'
import { SeatStore, digest } from '../src/store.ts'
import { admitLocalOpen } from '../src/open-admission.ts'

const tasks: [T.SeatTaskId, T.SeatTaskId] = ['task-a' as T.SeatTaskId, 'task-b' as T.SeatTaskId]
async function fixture() {
  const f = await engineFixture(true)
  const authority: T.SeatCallContext = { principalId: 'operator-a' as T.SeatPrincipalId,
    nodeId: f.options.nodeId, origin: 'manual' }
  const opened = await admitLocalOpen(f.engine, f.state, {
    request: { seat: f.definition.seat, origin: 'manual', operationId: operation('bound-window'), taskId: tasks[0] },
    authority, definition: f.definition, title: 'Bound window',
    opening: { text: 'Bound opening', digest: digest('Bound opening'),
      variables: { seat: f.definition.seat, date: '2026-01-01', taskId: tasks[0] ?? null } },
    openingContext: { reference: { providerId: 'binding-test' as T.OpeningProviderId,
      reference: 'window' as T.OpeningContextReference['reference'], revision: '1' },
    text: 'Bound tasks', digest: digest('Bound tasks'), revision: '1', taskIds: tasks, scopeEvidence: [] },
  }, f.options.nodeName)
  if (opened.status !== 'opened') { await f.close(); throw new Error('Expected an active bound window') }
  const store = await SeatStore.open(f.ctx.get('storageDomain')!, f.options.directory)
  await store.mutate(0, operation('bound-catalog'), f.definition, (catalog) => { catalog.definitions = [f.definition] })
  const service = new LocalSeatService(f.ctx, store, f.options, f.runtime)
  vi.spyOn(f.runtime, 'cache').mockImplementation(async () => ({ lastActivityAt: new Date().toISOString(),
    cacheTtlMs: 3600000, prefixDigest: digest('cached-prefix'), observedAt: new Date().toISOString(), reusableRequest: true }))
  return { ...f, authority, service, sessionId: opened.sessionId,
    async close() { await store.close(); await f.close() } }
}

for (const entry of ['close', 'renew', 'replace'] as const) {
  test.each(['principal', 'node', 'seat', 'tasks'] as const)(`${entry} rejects a live grant with mismatched %s before any business effect`, async (binding) => {
    const f = await fixture()
    let dispose: (() => void) | undefined
    try {
      const request = { sessionId: f.sessionId, operationId: operation(`bound-${entry}`),
        ...(entry === 'close' ? { expectedStateVersion: 1 } : {}) }
      const registration = f.engine.authorizationIssuers.register({ identity: { kind: 'local-operator',
        principalId: f.authority.principalId, origin: 'manual',
        nodeId: binding === 'node' ? 'other-node' as T.SeatNodeId : f.authority.nodeId,
        seat: binding === 'seat' ? 'other-seat' as T.SeatName : f.definition.seat,
        taskIds: binding === 'tasks' ? tasks.slice(0, 1) : tasks, policyRevision: 1 },
      current: () => ({ decision: 'allowed', reasonCode: 'authenticated-test-entry', policyRevision: 1 }) })
      dispose = () => { registration.dispose() }
      const grant = await registration.issuer.check({ operationId: request.operationId, requestDigest: digest(request) })
      if ('status' in grant) throw new Error('Expected a live issued grant')
      expect(f.engine.authorizationIssuers.verify(grant,
        { operationId: request.operationId, requestDigest: digest(request) }, grant.fact.nodeId)).toEqual(grant.fact)
      const caller = f.service.withAuthority({ ...f.authority, authorization: grant,
        ...(binding === 'principal' ? { principalId: 'operator-b' as T.SeatPrincipalId } : {}) })
      const before = await f.state.read()
      const authorizations = await f.engine.authorizations.query({ limit: 100 })
      const archive = vi.spyOn(f.ctx.workspaceRegistry, 'archiveSession')
      const closed = vi.spyOn(f.engine, 'recordClosed')
      const result = entry === 'close' ? await caller.close({ ...request, expectedStateVersion: 1 })
        : entry === 'renew' ? await caller.renew(request) : await caller.replace(request)
      const message = binding === 'principal' ? 'Action authorization does not match the calling principal.'
        : binding === 'node' ? 'Authorization grant does not match this action'
          : entry === 'close' ? 'Close attribution does not cover this window.'
            : 'Action attribution does not cover the target seat and tasks'
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'unauthorized', message, effectState: 'none' } })
      expect(await f.state.read()).toEqual(before)
      expect(await f.engine.authorizations.query({ limit: 100 })).toEqual(authorizations)
      expect(f.engine.journal.projection.closing.size).toBe(0)
      expect(f.engine.journal.projection.replacements.size).toBe(0)
      expect(f.engine.journal.projection.opens.has(f.sessionId)).toBe(true)
      expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(f.sessionId)
      expect(f.renewals).toEqual([])
      expect(archive).not.toHaveBeenCalled()
      expect(closed).not.toHaveBeenCalled()
    } finally { dispose?.(); vi.restoreAllMocks(); await f.close() }
  })
  test(`${entry} preserves the entirely unsigned trusted local entry`, async () => {
    const f = await fixture()
    try {
      const caller = f.service.withAuthority(f.authority)
      const request = { sessionId: f.sessionId, operationId: operation(`trusted-${entry}`) }
      const result = entry === 'close' ? await caller.close({ ...request, expectedStateVersion: 1 })
        : entry === 'renew' ? await caller.renew(request) : await caller.replace(request)
      expect(result).toMatchObject({ status: entry === 'close' ? 'closed' : entry === 'renew' ? 'renewed' : 'queued' })
    } finally { vi.restoreAllMocks(); await f.close() }
  })
}
