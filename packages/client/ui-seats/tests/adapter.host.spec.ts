import { Context } from '@panedesk/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SeatEngineService, SeatService } from '@panedesk/dsh-seat'
import SeatUi from '../src/index.ts'

function fixture() {
  const ctx = new Context()
  const open = vi.fn(async () => ({ status: 'cancelled' as const }))
  const definitions = vi.fn(async () => ({ definitions: [], revision: 1, complete: true }))
  const list = vi.fn(async () => ({ status: 'listed' as const, sessions: [], unopenedSeats: [], complete: true, snapshotAt: '' }))
  const binding = vi.fn(async () => null)
  const withAuthority = vi.fn((): SeatService => service)
  const service = { open, definitions, list, binding, withAuthority } as Partial<SeatService> as SeatService
  ctx.provide('seats', service)
  ctx.provide('seatEngine', { nodeStatus: async () => ({ nodeId: 'node-a' }) } as SeatEngineService)
  Object.defineProperty(ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } } } })
  return { ctx, ui: new SeatUi(ctx), open, definitions, list, binding, withAuthority }
}

describe('manual seat UI adapter', () => {
  it('derives owner authority from invocation and forces prefill without starting a model turn', async () => {
    const f = fixture()
    try {
      await f.ui.open({ seat: 'seat-a' as never, operationId: 'op-a' as never, expectedSeatRevision: 1 })
      expect(f.withAuthority).toHaveBeenCalledWith({ principalId: 'owner', nodeId: 'node-a', origin: 'manual' })
      expect(f.open).toHaveBeenCalledWith({ seat: 'seat-a', operationId: 'op-a', expectedSeatRevision: 1,
        origin: 'manual', openingMode: 'prefill' })
      await f.ui.open({ seat: 'seat-a' as never, operationId: 'op-directory' as never, expectedSeatRevision: 1,
        startupDirectory: '/registered' })
      expect(f.open).toHaveBeenLastCalledWith({ seat: 'seat-a', operationId: 'op-directory', expectedSeatRevision: 1,
        startupDirectory: '/registered', origin: 'manual', openingMode: 'prefill' })
      expect(await f.ui.overview()).toEqual({ available: true, definitions: [], windows: [], complete: true })
      expect(await f.ui.overview('session-a' as never)).toMatchObject({ binding: null })
      expect(f.binding).toHaveBeenCalledWith({ sessionId: 'session-a' })
    } finally { await f.ctx.fiber.dispose() }
  })
  it.each(['definitions', 'list'] as const)('keeps verified identity when %s is unavailable', async (failed) => {
    const f = fixture()
    const binding = { kind: 'free' as const, sessionId: 'session-a' as never, nodeId: 'node-a' as never, identitySource: 'free' as const }
    f.binding.mockImplementation(async () => binding as never)
    f[failed].mockRejectedValue(new Error('Catalog is unavailable'))
    try {
      expect(await f.ui.overview('session-a' as never)).toMatchObject({ binding, complete: false })
      expect(f.binding).toHaveBeenCalledWith({ sessionId: 'session-a' })
    } finally { await f.ctx.fiber.dispose() }
  })
  it('keeps the catalog readable when identity cannot be read', async () => {
    const f = fixture()
    f.binding.mockRejectedValue(new Error('Binding is unavailable'))
    try {
      expect(await f.ui.overview('session-a' as never)).toMatchObject({ available: true, complete: true,
        identityStatus: 'failed', definitions: [], windows: [] })
    } finally { await f.ctx.fiber.dispose() }
  })
  it('projects safe engine diagnostics independently of dispatchable windows', async () => {
    const f = fixture()
    const failure = { site: 'scheduled-drive', code: 'unclassified-error', since: '2026-01-01T00:00:00Z', retryable: false, attempts: 1 }
    const engine = f.ctx.get('seatEngine')!
    const read = vi.spyOn(engine, 'nodeStatus').mockResolvedValue({ nodeId: 'node-a' as never, nodeName: 'local',
      engine: 'unavailable', openEngineWindows: 0, limit: null, readyAt: null, failure,
      openingFailures: [{ sessionId: 'absent-a' as never, seat: 'seat-a' as never, agentPreset: 'agent-a', code: 'open-create-failed' }] })
    try {
      expect(await f.ui.overview()).toMatchObject({ windows: [], diagnostics: { engine: failure,
        openings: [{ agentPreset: 'agent-a', code: 'open-create-failed' }] } })
      read.mockResolvedValue({ nodeId: 'node-a' as never, nodeName: 'local', engine: 'running',
        openEngineWindows: 0, limit: null, readyAt: null })
      expect(await f.ui.overview()).not.toHaveProperty('diagnostics')
    } finally { read.mockRestore(); await f.ctx.fiber.dispose() }
  })
  it('projects parked issuer refusals without reporting an engine failure', async () => {
    const f = fixture(), engine = f.ctx.get('seatEngine')!
    const callback = { callbackId: 'callback-a' as never, seat: 'seat-a' as never, code: 'unauthorized' as const }
    const read = vi.spyOn(engine, 'nodeStatus').mockResolvedValue({ nodeId: 'node-a' as never, nodeName: 'local',
      engine: 'running', openEngineWindows: 0, limit: null, readyAt: null, callbackFailures: [callback] })
    try {
      expect(await f.ui.overview()).toMatchObject({ diagnostics: { openings: [], callbacks: [callback] } })
      expect((await f.ui.overview()).diagnostics?.engine).toBeUndefined()
      read.mockResolvedValue({ nodeId: 'node-a' as never, nodeName: 'local', engine: 'running',
        openEngineWindows: 0, limit: null, readyAt: null })
      expect(await f.ui.overview()).not.toHaveProperty('diagnostics')
    } finally { read.mockRestore(); await f.ctx.fiber.dispose() }
  })
  it('stops an aborted overview before provider reads', async () => {
    const f = fixture()
    try {
      await expect(f.ui.overview(undefined, AbortSignal.abort())).rejects.toThrow()
      expect(f.definitions).not.toHaveBeenCalled()
    } finally { await f.ctx.fiber.dispose() }
  })
  it('reports missing providers without constructing a runtime', async () => {
    const ctx = new Context()
    Object.defineProperty(ctx, 'invocation', { value: { peer: { principal: { kind: 'owner' } } } })
    try {
      expect(await new SeatUi(ctx).overview()).toEqual({ available: false, definitions: [], windows: [], complete: true })
      expect(ctx.get('seatEngine')).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })
})
