import { Context } from '@panedesk/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SeatService, SeatEngineService, OpenSeatRequest, OpenSeatBatchRequest, EngineEffect, SeatNodeId, SeatDefinition, SeatBinding, OpenSeatResult } from '@panedesk/dsh-seat'
import { executeSeatCommand, parseSeatArgs } from '../src/cli.ts'

function fixture() {
  const ctx = new Context()
  const effects: EngineEffect[] = []
  const open = vi.fn(async (request: OpenSeatRequest) => {
    if (request.nodeId === 'node-b') {
      const error = { code: 'cross-node-unsupported' as const, message: 'Only local seats are supported.', alternative: 'Use the owning node.', retryable: false, effectState: 'none' as const }
      effects.push({ eventId: 'event-a' as EngineEffect['eventId'], kind: 'open/rejected', seat: request.seat, operationId: request.operationId, data: { error, candidates: [] } })
      return { status: 'rejected' as const, error }
    }
    return { status: 'cancelled' as const }
  })
  const openBatch = vi.fn(async (request: OpenSeatBatchRequest) => ({ status: 'processed' as const,
    results: await Promise.all(request.seats.map(async seat => ({ seat,
      result: await open({ seat, operationId: request.operationId, origin: request.origin }),
    }))) }))
  const withAuthority = vi.fn((): SeatService => service)
  const service = { open, openBatch, withAuthority } as Partial<SeatService> as SeatService
  const engine = { nodeStatus: async () => ({ nodeId: 'node-a' as SeatNodeId, nodeName: 'node-a', engine: 'running', openEngineWindows: 0, limit: null, readyAt: null }),
    query: async () => ({ effects, complete: true, watermark: effects.length }) } as Partial<SeatEngineService> as SeatEngineService
  ctx.provide('seats', service); ctx.provide('seatEngine', engine)
  return { ctx, open, openBatch, service, engine, withAuthority }
}

describe('seat command consumer', () => {
  it('passes manual opening configuration to the shared SeatService', async () => {
    const f = fixture()
    try {
      expect(await executeSeatCommand(f.ctx, ['open', '--seat', 'seat-a', '--opening', 'auto', '--operation', 'operation-a'])).toEqual({ code: 0, output: { status: 'cancelled' } })
      expect(f.open).toHaveBeenCalledWith({ seat: 'seat-a', openingMode: 'auto', origin: 'manual', operationId: 'operation-a' })
      expect(f.withAuthority).toHaveBeenCalledWith({ principalId: 'owner', origin: 'manual', nodeId: 'node-a' })
    } finally { await f.ctx.fiber.dispose() }
  })
  it('preserves complete definition assembly, dated title and first-run identity through the CLI provider seam', async () => {
    const f = fixture()
    const definition: SeatDefinition = {
      schemaVersion: 1, revision: 3, seat: 'seat-a' as never, platform: 'server', node: 'node-a', projectId: 'project-a' as never,
      directories: [{ path: 'workspace-a', startup: true }, { path: 'workspace-b', startup: false }], memoryDirectories: ['memory-a'],
      opening: { kind: 'text', text: 'Start the assigned task.' }, openingInstructionFiles: ['opening.md'], agentPreset: 'agent-a',
      provider: 'provider-a', model: 'model-a', reasoningEffort: 'high', permissionPreset: 'permission-a', subscriptions: ['instruction-a'],
      checkpointFiles: [{ path: 'checkpoint.md', section: 'Context', maxBytes: 4096, required: true }], maxOpenSessions: 1,
      maxActiveSubagents: 4, subagentContextThresholdTokens: 1000, rules: [],
      worktree: { clientTreesPerSlot: 1, staleOnSettle: 'notify', lightByDefault: true, staleHours: 24 },
    }
    const binding: SeatBinding = { kind: 'seat', sessionId: 'session-a' as never, seat: definition.seat, projectId: definition.projectId,
      nodeId: 'node-a' as SeatNodeId, bindingSource: 'seat-definition', identitySource: 'settings', openOperationId: 'operation-a' as never,
      seatRevision: definition.revision, relatedTaskIds: [], directories: definition.directories,
      memoryDirectories: definition.memoryDirectories,
      subscriptions: definition.subscriptions, openingDigest: 'digest-a' as never }
    const configured = vi.fn(), firstRun = vi.fn()
    const open = vi.fn(async (request: OpenSeatRequest): Promise<OpenSeatResult> => {
      expect(request.seat).toBe(definition.seat)
      configured(structuredClone(definition))
      firstRun({ seat: binding.seat, window: binding.sessionId, identitySource: binding.identitySource, opening: definition.opening })
      return { status: 'opened', sessionId: binding.sessionId, seat: binding.seat, nodeId: binding.nodeId, nodeName: 'node-a',
        title: `seat-a ${new Date().toISOString().slice(0, 10)}`, budget: {}, phase: 'active', stateVersion: 1, callbackIds: [] }
    })
    f.service.open = open
    try {
      const result = await executeSeatCommand(f.ctx, ['open', '--seat', 'seat-a', '--opening', 'auto', '--operation', 'operation-a'])
      expect(result).toMatchObject({ code: 0, output: { status: 'opened', title: `seat-a ${new Date().toISOString().slice(0, 10)}` } })
      expect(configured).toHaveBeenCalledExactlyOnceWith(definition)
      expect(firstRun).toHaveBeenCalledExactlyOnceWith({ seat: 'seat-a', window: 'session-a', identitySource: 'settings', opening: definition.opening })
      expect(open).toHaveBeenCalledExactlyOnceWith({ seat: 'seat-a', operationId: 'operation-a', origin: 'manual', openingMode: 'auto' })
    } finally { await f.ctx.fiber.dispose() }
  })
  it('returns one outcome for each explicit seat and never expands all', async () => {
    const f = fixture()
    try {
      expect(await executeSeatCommand(f.ctx, ['open', '--seats', 'seat-a,seat-b,seat-c', '--operation', 'operation-a']))
        .toMatchObject({ code: 0, output: { status: 'processed', results: [{ seat: 'seat-a' }, { seat: 'seat-b' }, { seat: 'seat-c' }] } })
      expect(f.open.mock.calls.map(([request]) => request.seat)).toEqual(['seat-a', 'seat-b', 'seat-c'])
      for (const seats of ['all', '*', String.fromCodePoint(0x5168, 0x90e8), '']) expect((await executeSeatCommand(f.ctx, ['open', '--seats', seats])).code).toBe(2)
      expect(f.openBatch).toHaveBeenCalledTimes(1)
    } finally { await f.ctx.fiber.dispose() }
  })
  it('preserves cross-node refusal and its queryable ledger fact', async () => {
    const f = fixture()
    try {
      expect(await executeSeatCommand(f.ctx, ['open', '--seat', 'seat-a', '--node', 'node-b', '--operation', 'operation-a']))
        .toMatchObject({ code: 2, output: { status: 'rejected', error: { code: 'cross-node-unsupported', effectState: 'none' } } })
      const page = await f.engine.query({ limit: 10 })
      expect(page.effects).toEqual([{ eventId: 'event-a', kind: 'open/rejected', seat: 'seat-a', operationId: 'operation-a',
        data: { error: { code: 'cross-node-unsupported', message: 'Only local seats are supported.', alternative: 'Use the owning node.', retryable: false, effectState: 'none' }, candidates: [] } }])
      expect(await f.engine.nodeStatus()).toMatchObject({ nodeName: 'node-a', openEngineWindows: 0 })
    } finally { await f.ctx.fiber.dispose() }
  })
  it('passes management JSON unchanged and rejects mixed flags before provider mutation', async () => {
    const f = fixture()
    const request = { authority: 'seat-store', authorizationRef: 'authorization-a', expectedRevision: 1, operationId: 'operation-a' }
    const setAuthority = vi.fn(async () => ({ status: 'saved' as const, revision: 2 }))
    f.service.setAuthority = setAuthority
    try {
      expect(await executeSeatCommand(f.ctx, ['setAuthority', '--request', JSON.stringify(request), '--json']))
        .toEqual({ code: 0, output: { status: 'saved', revision: 2 } })
      expect(setAuthority).toHaveBeenCalledExactlyOnceWith(request)
      expect((await executeSeatCommand(f.ctx, ['setAuthority', '--request', JSON.stringify(request), '--revision', '1'])).code).toBe(2)
      expect(setAuthority).toHaveBeenCalledTimes(1)
    } finally { await f.ctx.fiber.dispose() }
  })
  it('rejects missing versions and unknown authority fields before invocation', () => {
    expect(() => parseSeatArgs(['close', '--session', 'session-a'])).toThrow()
    expect(() => parseSeatArgs(['open', '--seat', 'seat-a', '--principal', 'owner'])).toThrow()
    expect(parseSeatArgs(['open', '--seat', 'seat-a', '--operation', 'operation-a'])).toMatchObject({ request: { openingMode: 'prefill' } })
  })
  it('reports unavailable providers without activating a runtime', async () => {
    const ctx = new Context()
    try { expect(await executeSeatCommand(ctx, ['list'])).toMatchObject({ code: 2, output: { error: { code: 'unavailable' } } }) }
    finally { await ctx.fiber.dispose() }
  })
})
