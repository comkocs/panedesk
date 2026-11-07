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
