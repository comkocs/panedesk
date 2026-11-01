/** Direct profile access rejects non-owner invocations before reaching the catalog service. */
import { expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { SeatStore } from '../src/store.ts'

it.each(['guest', 'anonymous', 'session', 'aborted'] as const)('refuses %s direct profile calls before catalog access', async (kind) => {
  const f = await admissionHost()
  try {
    const access = f.ctx.get('seatProfilesLocal')
    const service = f.ctx.get('seats')
    if (!access || !service) throw new Error('Profile services unavailable')
    const provider = vi.spyOn(service, 'withAuthority')
    const snapshot = vi.spyOn(SeatStore.prototype, 'snapshot')
    const mutate = vi.spyOn(SeatStore.prototype, 'mutate')
    const controller = new AbortController()
    if (kind === 'aborted') controller.abort()
    Object.defineProperty(f.ctx, 'invocation', { configurable: true,
      value: { peer: { principal: { kind: kind === 'aborted' ? 'owner' : kind } }, signal: controller.signal } })
    const operationId = 'denied-profile' as T.SeatOperationId
    const calls = [
      () => access.read(),
      () => access.save({ definition: f.definition, expectedRevision: 2, operationId }),
      () => access.preview({ format: 'csv', sourcePath: '/missing', columnMap: {}, defaults: {} }),
      () => access.commit({ planId: 'missing' as T.SeatImportPlanId, selectedRows: [], expectedRevision: 2, operationId }),
      () => access.takeover({ expectedRevision: 2, operationId, confirmed: true }),
    ]
    for (const call of calls) {
      await expect(Promise.resolve().then(call)).rejects.toMatchObject({ failure: { code: 'unauthorized' } })
    }
    await expect(access.remove({ seat: f.definition.seat, expectedRevision: 2, operationId, confirmed: true,
      windows: [], pending: [], engineSequence: 0, windowVersions: [], pendingVersions: [] }))
      .resolves.toMatchObject({ status: 'rejected', error: { code: 'unauthorized' } })
    expect(provider).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  } finally { vi.restoreAllMocks(); await f.close() }
})
