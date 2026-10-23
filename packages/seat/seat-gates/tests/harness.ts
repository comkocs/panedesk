import { Context } from '@panedesk/cordis'
import type { EngineDecision, EngineEffect, SeatDefinition, SeatEngineService, SeatService, SeatBinding } from '@panedesk/dsh-seat'
import { SessionId } from '@panedesk/dsh-session'
import type { Config } from '../src/index.ts'

export const config: Config = {
  definitions: [], pollingThreshold: 3, maxSleepSeconds: 600, checkpointMaxBytes: 32768,
  checkpointRetryLimit: 2, ledgerCheckpointReserveTokens: 10, memoryAuditMaxBytes: 4096, memoryAuditMaxFiles: 16, timeZone: 'UTC',
}
export const profile: SeatDefinition = {
  schemaVersion: 1, revision: 1, seat: 'seat-a' as SeatDefinition['seat'], platform: 'server', node: 'node-a',
  projectId: 'project-a' as SeatDefinition['projectId'], directories: [], memoryDirectories: [], opening: { kind: 'text', text: '' },
  openingInstructionFiles: [], agentPreset: 'agent-a', provider: 'provider-a', model: 'model-a', reasoningEffort: 'high',
  permissionPreset: 'read-only', subscriptions: [], checkpointFiles: [], maxOpenSessions: 1, maxActiveSubagents: 2,
  subagentContextThresholdTokens: 400000, rules: [],
  worktree: { clientTreesPerSlot: 1, staleOnSettle: 'notify', lightByDefault: true, staleHours: 48 },
}
export function engineStub() {
  const effects: EngineEffect[] = []
  let sequence = 0
  const engine: Pick<SeatEngineService, 'query' | 'appendEffects' | 'nodeStatus'> = {
    async nodeStatus() { return { nodeId: 'node-a' as EngineDecision['nodeId'], nodeName: 'node-a',
      engine: 'running', openEngineWindows: 0, limit: null, readyAt: null } },
    async query(request) {
      return { effects: effects.filter(item => request.kinds === undefined || request.kinds.includes(item.kind)),
        watermark: sequence, complete: true }
    },
    async appendEffects(request) {
      if (request.expectedSequence !== sequence) return { status: 'conflict', actualSequence: sequence }
      effects.push(...request.effects)
      const decision: EngineDecision = { ...request, sequence: ++sequence, nodeId: 'node-a' as EngineDecision['nodeId'],
        namespace: 'ledger/engine/v1', schemaVersion: 1, digest: 'digest-a' as EngineDecision['digest'], byteLength: 1 }
      return { status: 'committed', decision }
    },
  }
  return { engine, effects }
}
export function seatStub(definition = profile, binding: SeatBinding | null = null) {
  const seats: Pick<SeatService, 'resolve' | 'definitions' | 'binding' | 'list'> = {
    async resolve() { return definition },
    async definitions() { return { definitions: [definition], complete: true, revision: definition.revision } },
    async binding() { return binding },
    async list() { return { status: 'listed', sessions: [], unopenedSeats: [], snapshotAt: '2026-01-01T00:00:00Z', complete: true } },
  }
  return seats
}
export function policyContext(definition = profile, binding: SeatBinding | null = null) {
  const ctx = new Context()
  const journal = engineStub()
  ctx.provide('seatEngine', journal.engine as SeatEngineService)
  ctx.provide('seats', seatStub(definition, binding) as SeatService)
  return { ctx, ...journal }
}
export const sessionId = SessionId('session-a')
