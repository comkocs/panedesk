import { EventEmitter } from 'node:events'
import { Context } from '@panedesk/cordis'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionSourceRegistry, OwnerConnectionSource, type ConnectionSource } from '../src/connection-source.ts'

const unknownReason = 'The connection source could not be verified and cannot act as owner. / 本请求的连接来源查不出，不能以 owner 身份执行。'

describe('owner physical socket edge observations', () => {
  it('refuses destroyed sockets without consulting a platform provider', () => {
    const lookup = vi.fn((): ConnectionSource => 'non-product')
    const guard = new OwnerConnectionSource(lookup)
    const socket = { destroyed: true }
    expect(guard.rejection({ headers: {}, socket })).toBe(unknownReason)
    expect(guard.rejection({ headers: {}, socket })).toBe(unknownReason)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('caches transport facts that do not expose a close listener', () => {
    const lookup = vi.fn((): ConnectionSource => 'unknown')
    const guard = new OwnerConnectionSource(lookup)
    const socket = { remoteAddress: 'fixture-client' }
    expect(guard.rejection({ headers: {}, socket })).toBe(unknownReason)
    expect(guard.rejection({ headers: {}, socket })).toBe(unknownReason)
    expect(lookup).toHaveBeenCalledExactlyOnceWith(socket)
    expect(guard.rejection({ headers: {} })).toBe(unknownReason)
    expect(lookup).toHaveBeenLastCalledWith(undefined)
  })

  it('releases the cached decision when the physical socket closes', () => {
    const lookup = vi.fn((): ConnectionSource => 'non-product')
    const guard = new OwnerConnectionSource(lookup)
    const socket = new EventEmitter()
    expect(guard.rejection({ headers: {}, socket })).toBeUndefined()
    lookup.mockReturnValue('unknown')
    expect(guard.rejection({ headers: {}, socket })).toBeUndefined()
    socket.emit('close')
    expect(guard.rejection({ headers: {}, socket })).toBe(unknownReason)
    expect(lookup.mock.calls).toEqual([[socket], [socket]])
  })

  it('restores an explicitly registered provider after withdrawal', async () => {
    const ctx = new Context()
    const registry = new ConnectionSourceRegistry(ctx)
    const socket = { remoteAddress: 'fixture-client' }
    const first = vi.fn((): ConnectionSource => 'product-sandbox')
    const second = vi.fn((): ConnectionSource => 'non-product')
    try {
      const dispose = registry.register(process.platform, first)
      expect(registry.classify(socket)).toBe('product-sandbox')
      expect(first).toHaveBeenCalledExactlyOnceWith(socket)
      await dispose()
      expect(registry.classify(socket)).toBe('unknown')
      registry.register(process.platform, second)
      expect(registry.classify(socket)).toBe('non-product')
      expect(second).toHaveBeenCalledExactlyOnceWith(socket)
    } finally { await ctx.fiber.dispose() }
  })
})
