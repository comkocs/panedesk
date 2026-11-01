import { expect, it, vi } from 'vitest'
import { admissionHost } from '../../../seat/seat-local/tests/admission-host.ts'
import { SeatStore } from '../../../seat/seat-local/src/store.ts'
import SeatUi from '../src/index.ts'

it('preserves the profile authorization refusal for an owner dashboard without profile authority', async () => {
  const f = await admissionHost()
  try {
    const profiles = f.ctx.get('seatProfilesLocal')
    if (!profiles) throw new Error('Profile service unavailable')
    const snapshot = vi.spyOn(SeatStore.prototype, 'snapshot')
    const signal = AbortSignal.abort()
    Object.defineProperty(f.ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } }, signal } })
    await expect(new SeatUi(f.ctx).dashboard()).rejects.toMatchObject({ failure: {
      code: 'unauthorized', message: 'Authenticated owner required.', alternative: 'Sign in as the local owner.',
      retryable: false, effectState: 'none',
    } })
    expect(snapshot).not.toHaveBeenCalled()
  } finally { vi.restoreAllMocks(); await f.close() }
}, 30000)
