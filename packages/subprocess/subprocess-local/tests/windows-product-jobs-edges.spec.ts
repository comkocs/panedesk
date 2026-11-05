import { Context } from '@panedesk/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowsProductJobs } from '../src/windows-product-jobs.ts'

const native = vi.hoisted(() => ({ create: vi.fn(), load: vi.fn(), lookup: vi.fn(), close: vi.fn(), empty: vi.fn() }))
vi.mock('@panedesk/dsh-win32-process', async original => ({ ...await original<typeof import('@panedesk/dsh-win32-process')>(), createProductJob: native.create, loadTcpOwnerBindings: native.load, lookupTcpOwner: native.lookup }))
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks() })

describe('Windows product identity owner incomplete observations', () => {
  it('refuses preparation after disposal and ignores settlement without a live identity', async () => {
    const ctx = new Context()
    const owner = WindowsProductJobs.forHost(ctx)
    owner.settle({})
    await ctx.fiber.dispose()
    owner.settle({ DSH_WINDOWS_PRODUCT_JOB: 'missing' })
    expect(() => owner.prepare({})).toThrow('owner is closed')
    expect(native.create).not.toHaveBeenCalled()
    expect(owner.classify(undefined)).toBe('unknown')
  })
  it('retains unverifiable settled identities and does not settle another launch', async () => {
    const ctx = new Context()
    let serial = 0
    native.create.mockImplementation(() => ({ name: `job-${++serial}`, handle: BigInt(serial), close: native.close, empty: native.empty }))
    native.empty.mockImplementation(() => { throw new Error('Accounting unavailable') })
    native.lookup.mockReturnValue('product-sandbox')
    const report = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const owner = WindowsProductJobs.forHost(ctx)
    try {
      const first = owner.prepare({})
      owner.prepare({})
      owner.settle(first)
      expect(native.empty).toHaveBeenCalledOnce()
      expect(report).toHaveBeenCalledOnce()
      expect(native.close).not.toHaveBeenCalled()
      expect(owner.classify(undefined)).toBe('product-sandbox')
      expect(native.lookup.mock.calls.at(-1)?.[1]).toEqual([1n, 2n])
    } finally { await ctx.fiber.dispose() }
    expect(native.close).toHaveBeenCalledTimes(2)
  })
  it('returns unknown when platform bindings cannot load', async () => {
    const ctx = new Context()
    native.load.mockImplementation(() => { throw new Error('Bindings unavailable') })
    try { expect(WindowsProductJobs.forHost(ctx).classify(undefined)).toBe('unknown') }
    finally { await ctx.fiber.dispose() }
  })
})
