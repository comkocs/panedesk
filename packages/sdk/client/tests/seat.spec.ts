import { describe, expect, it, vi } from 'vitest'
import { SeatsClient } from '../src/seats.ts'

describe('seat TypeScript SDK projection', () => {
  it('projects seat operations and binding without changing session events', async () => {
    const queued = { status: 'queued', queueItemId: 'queue-a', sequence: 2, reason: 'seat-capacity', blockedBy: ['seat-a'] }
    const binding = { kind: 'free', sessionId: 'session-a', nodeId: 'node-a', identitySource: 'free' }
    const request = vi.fn(async (method: string) => method === 'seats/binding' ? binding : queued)
    const seats = new SeatsClient(request)
    expect(await seats.open({ seat: 'seat-a' as never, operationId: 'operation-a' as never })).toEqual(queued)
    expect(request).toHaveBeenNthCalledWith(1, 'seats/open', { seat: 'seat-a', operationId: 'operation-a', origin: 'remote', openingMode: 'auto' })
    expect(await seats.binding({ sessionId: 'session-a' as never })).toEqual(binding)
    expect(request.mock.calls.map(([method]) => method)).toEqual(['seats/open', 'seats/binding'])
  })
  it('preserves explicit batch outcomes and never retries a transport failure', async () => {
    const result = { status: 'processed', results: ['seat-a', 'seat-b', 'seat-c'].map(seat => ({ seat, result: { status: 'cancelled' } })) }
    const request = vi.fn().mockResolvedValueOnce(result).mockRejectedValueOnce(new Error('unavailable'))
    const seats = new SeatsClient(request)
    expect(await seats.openBatch({ seats: ['seat-a', 'seat-b', 'seat-c'] as never, operationId: 'operation-a' as never })).toEqual(result)
    await expect(seats.open({ seat: 'seat-a' as never, operationId: 'operation-b' as never })).rejects.toThrow('unavailable')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('projects management revisions and rejects malformed nested provider results', async () => {
    const request = vi.fn().mockResolvedValueOnce({ status: 'saved', revision: 2 })
      .mockResolvedValueOnce({ status: 'committed', revision: 2, rows: [{ row: 1 }] })
    const seats = new SeatsClient(request)
    const authority = { authority: 'seat-store' as const, authorizationRef: 'authorization-a' as never, expectedRevision: 1, operationId: 'operation-a' as never }
    expect(await seats.setAuthority(authority)).toEqual({ status: 'saved', revision: 2 })
    expect(request).toHaveBeenNthCalledWith(1, 'seats/setAuthority', authority)
    await expect(seats.commitImport({ planId: 'plan-a' as never, selectedRows: [1], expectedRevision: 1, operationId: 'operation-b' as never }))
      .rejects.toThrow('Invalid seats/import.commit result')
    await expect(seats.setAuthority({ ...authority, expectedRevision: -1 })).rejects.toThrow('parameters')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('rejects invalid results instead of reporting a created window', async () => {
    const seats = new SeatsClient(async () => ({ status: 'opened' }))
    await expect(seats.open({ seat: 'seat-a' as never, operationId: 'operation-a' as never })).rejects.toThrow('Invalid seats/open result')
  })
})
