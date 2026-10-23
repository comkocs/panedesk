import { Context } from '@panedesk/cordis'
import type { AgentRegistry } from '@panedesk/dsh-agent'
import type { LlmRuntime } from '@panedesk/dsh-llm'
import type { SeatEngineService, SeatService } from '@panedesk/dsh-seat'
import { describe, expect, it, vi } from 'vitest'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

async function fixture(installed = true) {
  const ctx = new Context()
  ctx.provide('llm', { listProviders: () => [{ id: 'fixture', name: 'Fixture' }], resolveCallConfig: async () => ({ provider: 'fixture', model: 'fixture' }) } as Partial<LlmRuntime> as LlmRuntime)
  ctx.provide('agents', { currentInitiator: () => undefined } as Partial<AgentRegistry> as AgentRegistry)
  const open = vi.fn(async () => ({ status: 'cancelled' as const }))
  const withAuthority = vi.fn((): SeatService => seats)
  const management = {
    previewImport: vi.fn<SeatService['previewImport']>(async () => ({ planId: 'plan-a' as never, sourceFileHash: 'digest-a' as never, mappingHash: 'digest-b' as never, baseRevision: 0, rows: [] })),
    commitImport: vi.fn<SeatService['commitImport']>(async () => ({ status: 'committed', revision: 1, rows: [] })),
    setAuthority: vi.fn<SeatService['setAuthority']>(async () => ({ status: 'saved', revision: 2 })),
    submitReport: vi.fn<SeatService['submitReport']>(async () => ({ status: 'recorded', reportId: 'report-a' as never, stateVersion: 1 })),
    registerWait: vi.fn<SeatService['registerWait']>(async () => ({ status: 'rejected', error: { code: 'wait-object-not-found', message: 'Missing object.', alternative: 'Select an existing object.', retryable: false, effectState: 'none' } })),
    cancelWait: vi.fn<SeatService['cancelWait']>(async () => ({ status: 'rejected', error: { code: 'state-conflict', message: 'State changed.', alternative: 'Read the current state.', retryable: false, effectState: 'none' } })),
  }
  const seats = { open, withAuthority, ...management } as Partial<SeatService> as SeatService
  if (installed) {
    ctx.provide('seats', seats)
    ctx.provide('seatEngine', { nodeStatus: async () => ({ nodeId: 'node-a' }) } as SeatEngineService)
  }
  const server = new HarnessSdkJsonRpcServer(ctx, { notify() {}, request: async () => ({}) })
  await server.initialize({ cwd: process.cwd(), provider: 'fixture', model: 'fixture' })
  return { ctx, server, seats, open, withAuthority, management }
}

describe('seat SDK routes', () => {
  it('routes exact opening through the shared service and captures local authority', async () => {
    const f = await fixture()
    try {
      expect(await f.server.handleRequest('seats/open', { seat: 'seat-a', operationId: 'operation-a', origin: 'manual', openingMode: 'prefill' })).toEqual({ status: 'cancelled' })
      expect(f.open).toHaveBeenCalledWith({ seat: 'seat-a', operationId: 'operation-a', origin: 'remote', openingMode: 'auto' })
      expect(f.withAuthority).toHaveBeenCalledWith({ principalId: 'owner', origin: 'remote', nodeId: 'node-a' })
      await expect(f.server.handleRequest('seats/open', { seat: 'seat-a', operationId: 'operation-b', origin: 'remote', principalId: 'owner' })).rejects.toThrow('Invalid seats/open parameters')
      expect(f.open).toHaveBeenCalledTimes(1)
    } finally { await f.server.shutdown(); await f.ctx.fiber.dispose() }
  })
  it('routes every management method and rejects injected authority before provider mutation', async () => {
    const f = await fixture()
    const report = { reportId: 'report-a', sessionId: 'session-a', canClose: false, waitingFor: [],
      nextOpen: { when: { kind: 'unspecified' }, prerequisites: [] }, submittedAt: '2026-01-01T00:00:00Z', stateVersion: 1 }
    const cases = [
      ['import.preview', 'previewImport', { format: 'csv', sourcePath: 'seats.csv', columnMap: {}, defaults: {} }],
      ['import.commit', 'commitImport', { planId: 'plan-a', selectedRows: [1], expectedRevision: 0, operationId: 'operation-a' }],
      ['setAuthority', 'setAuthority', { authority: 'seat-store', authorizationRef: 'authorization-a', expectedRevision: 1, operationId: 'operation-a' }],
      ['report.submit', 'submitReport', { report, operationId: 'operation-a' }],
      ['wait.register', 'registerWait', { waitId: 'wait-a', sessionId: 'session-a', mode: 'all', objects: [{ kind: 'job', id: 'job-a' }], operationId: 'operation-a' }],
      ['wait.cancel', 'cancelWait', { waitId: 'wait-a', sessionId: 'session-a', expectedStateVersion: 1, operationId: 'operation-b' }],
    ] as const
    try {
      for (const [method, target, request] of cases) {
        await f.server.handleRequest(`seats/${method}`, request)
        expect(f.management[target]).toHaveBeenCalledExactlyOnceWith(request)
        await expect(f.server.handleRequest(`seats/${method}`, { ...request, principalId: 'owner' })).rejects.toThrow('parameters')
        expect(f.management[target]).toHaveBeenCalledTimes(1)
      }
      expect(f.open).not.toHaveBeenCalled()
    } finally { await f.server.shutdown(); await f.ctx.fiber.dispose() }
  })
  it('reports unsupported when no seat provider is installed without changing initialization', async () => {
    const f = await fixture(false)
    try {
      await expect(f.server.handleRequest('seats/list', {})).rejects.toThrow('unavailable')
      expect(f.open).not.toHaveBeenCalled()
      expect(f.ctx.get('seats')).toBeUndefined()
    } finally { await f.server.shutdown(); await f.ctx.fiber.dispose() }
  })
})
