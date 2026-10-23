import { describe, expect, it, vi } from 'vitest'
import type { SeatDirectoryService } from '@panedesk/dsh-seat'
import { registerDirectoryTools } from '../src/directories.ts'
import { harness } from './harness.ts'

describe('registered-root model tools', () => {
  it('passes trusted session identity and an opaque root ID to the permission-owning provider', async () => {
    const { ctx, execute } = await harness()
    const write = vi.fn<SeatDirectoryService['write']>(async () => ({ status: 'rejected', error: {
      code: 'memory-seat-mismatch', alternative: 'Use the owning seat.', message: 'Not authorized.', retryable: false, effectState: 'none',
    } }))
    const read = vi.fn<SeatDirectoryService['read']>(async () => ({ status: 'read', content: 'bounded data', complete: false }))
    ctx.provide('seatDirectories', { write, read } as Partial<SeatDirectoryService> as SeatDirectoryService)
    registerDirectoryTools(ctx)
    try {
      const denied = await execute('seat_write', { rootId: 'root-a', relativePath: 'note.md', content: 'data' })
      expect(JSON.stringify(denied.content)).toContain('memory-seat-mismatch')
      expect(write).toHaveBeenCalledWith({ rootId: 'root-a', relativePath: 'note.md', content: 'data', sessionId: 'session-a', operationId: 'tool:session-a:call-1' })
      const result = await execute('seat_read', { rootId: 'root-a', relativePath: 'note.md', maxBytes: 20 })
      expect(result.isError).toBe(false)
      expect(JSON.stringify(result.content)).toContain('bounded data')
      expect(read).toHaveBeenCalledWith({ rootId: 'root-a', relativePath: 'note.md', maxBytes: 20, sessionId: 'session-a' })
      expect((await execute('seat_read', { rootId: 'root-a', relativePath: 'note.md', maxBytes: 0 })).isError).toBe(true)
      expect(read).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })
  it('does not expose arbitrary authorization roots in tool schemas', async () => {
    const { ctx } = await harness()
    registerDirectoryTools(ctx)
    try {
      for (const schema of ctx.tools.schemas().filter(item => ['seat_read', 'seat_write', 'seat_edit'].includes(item.name))) {
        expect(JSON.stringify(schema.parameters)).toContain('rootId')
        expect(JSON.stringify(schema.parameters)).not.toContain('authorizedDirectories')
        expect(JSON.stringify(schema.parameters)).not.toContain('danger-full-access')
      }
    } finally { await ctx.fiber.dispose() }
  })
})
