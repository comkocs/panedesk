/** Neutral isolated providers exercise engine ownership without other seat implementations. */
import { Context } from '@panedesk/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionId } from '@panedesk/dsh-session'
import type { SessionLedger, LedgerSnapshot } from '@panedesk/dsh-session-ledger'
import type * as T from '@panedesk/dsh-seat'
import { SeatEngine } from '../src/engine.ts'
import { digest } from '../src/journal.ts'

export const nodeId = 'node-a' as T.SeatNodeId
export const seat = 'seat-a' as T.SeatName
export const projectId = 'project-a' as T.SeatProjectId
export const sourceId = 'source-a' as T.SeatSourceId
export const config: T.SeatEngineConfig = { nodeName: 'node-a', nodeAliases: { local: nodeId }, dedupWindowMs: 1000,
  maxDecisionBytes: 200000, maxSourceBytes: 20000, maxBatchSeats: 10, maxCauseDepth: 8, budgetTimeZone: 'UTC',
  callbackTimeoutMs: 1000, callbackMaxResponseBytes: 1000, callbackRetryInitialMs: 1, callbackRetryMaxMs: 100,
  ownerObserveIntervalMs: 1000, ownerReleaseBudgetMs: 2000, queueWakeBudgetMs: 1000 }
export function definition(name = seat): T.SeatDefinition {
  return { schemaVersion: 1, revision: 1, seat: name, platform: 'server', node: 'local', projectId,
    directories: [{ path: '/workspace', startup: true }], memoryDirectories: [], opening: { kind: 'text',
      text: 'Begin the assigned task.' },
    openingInstructionFiles: [], agentPreset: 'agent-a', provider: 'provider-a', model: 'model-a', reasoningEffort: 'medium',
    permissionPreset: 'default', subscriptions: [], checkpointFiles: [], maxOpenSessions: 1, maxActiveSubagents: 4,
    subagentContextThresholdTokens: 400000, rules: [], worktree: { clientTreesPerSlot: 1, staleOnSettle: 'notify',
      lightByDefault: true, staleHours: 48 } }
}
export function trigger(kind: T.SeatTrigger['kind'] = 'external', id = 'event-a', target = seat): T.TriggerEnvelope {
  const evidence: T.SeatTriggerEvidence = kind === 'external' ? { kind, eventType: 'event-a' }
    : kind === 'manual' ? { kind, origin: 'manual', operationId: id as T.SeatOperationId }
      : kind === 'schedule' ? { kind, scheduleId: 'schedule-a' as never, scheduledAt: '2026-01-01T00:00:00Z' }
        : kind === 'git' ? { kind, repositoryId: 'repo-a' as never, ref: 'refs/heads/main',
          oldObjectId: null, newObjectId: 'a'.repeat(40), observationSequence: 1 }
          : kind === 'window-ended' ? { kind, sessionId: 'ended-a' as SessionId, endedEventId: id as T.SourceEventId,
            reportId: null, origin: 'closed' }
            : { kind, messageId: 'message-a' as never, senderSessionId: 'sender-a' as SessionId, deadlineVersion: 1,
              deadlineAt: '2026-01-01T00:00:00Z', timeoutMinutes: 1, wakeOperationId: 'wake-a' as T.SeatOperationId }
  return { triggerId: id as T.TriggerId, sourceId, eventId: id as T.SourceEventId, kind, evidence, seat: target, projectId,
    receivedAt: '2026-01-01T00:00:00Z', dataDigest: digest(null), data: null, callbackRef: sourceId }
}
export function budget(sessionId = 'window-a' as SessionId): T.SeatBudgetSnapshot {
  return { sessionId, seat, currency: 'USD', costState: 'known', windowCost: '0' as T.MicroUsd, dailyCost: '0' as T.MicroUsd,
    limits: {}, dayKey: '2026-01-01', budgetTimeZone: 'UTC', inFlightUnknown: 0, watermark: 0, budgetRevision: 0 }
}
export async function harness(options: Partial<T.SeatEngineConfig> = {}) {
  const home = await mkdtemp(join(process.cwd(), 'packages/seat/seat-engine/tests/.home-'))
  const definitions = new Map<T.SeatName, T.SeatDefinition>([[seat, definition()]])
  const physical = new Set<SessionId>(), creates: SessionId[] = [], callbacks: T.SeatCallbackPayload[] = []
  const wakes: T.SeatHandoffTimeout[] = [], warnings: Parameters<NonNullable<T.SeatOpenExecutor['notifyBudget']>>[0][] = []
  const warned = new Set<T.SeatOperationId>()
  const state = { owner: 'alive' as 'alive' | 'dead' | 'unknown', opening: 'completed' as 'pending' | 'completed' | 'failed',
    callbackFailures: 0, snapshot: { asOf: 1, watermarks: {}, complete: true, rows: [] } as LedgerSnapshot }
  const executor: T.SeatOpenExecutor = {
    observe: async open => physical.has(open.sessionId) ? 'matching' : 'absent',
    create: async (open) => { physical.add(open.sessionId); creates.push(open.sessionId); return open.sessionId },
    configure: async () => {}, opening: async () => ({ messageId: 'opening-a' as never, state: state.opening }),
    wakeSender: async (timeout) => { wakes.push(timeout); return 'sent' }, owner: async () => state.owner,
    notifyBudget: async (request) => { if (!warned.has(request.operationId)) { warned.add(request.operationId); warnings.push(request) } },
  }
  const source: T.SeatTriggerSource = { sourceId, kinds: ['external', 'manual', 'schedule',
    'git', 'window-ended', 'handoff-timeout'], maxRedeliveryMs: null,
  callback: async (payload) => { callbacks.push(payload); if (state.callbackFailures-- > 0) throw new Error('Transient callback failure') } }
  const contexts: Context[] = [], engines: SeatEngine[] = []
  async function start() {
    const ctx = new Context(); contexts.push(ctx)
    const engine = new SeatEngine(ctx, { home, nodeId, config: { ...config, ...options } }, {
      seats: () => ({ resolve: async (name: T.SeatName) => definitions.get(name)! }) as T.SeatService,
      ledger: () => ({ snapshot: async () => state.snapshot }) as SessionLedger,
    })
    engines.push(engine); engine.registerExecutor(executor); engine.registerSource(source); await engine.ready()
    return engine
  }
  const engine = await start()
  return { home, engine, definitions, physical, creates, callbacks, wakes, warnings, state, executor, start,
    close: async () => { for (const engine of engines) await engine.shutdown(); for (const ctx of contexts) await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true }) } }
}
export async function auto(engine: SeatEngine) {
  await engine.setProjectMode({ projectId, mode: 'auto', expectedRevision: 0, operationId: 'policy-a' as T.SeatOperationId })
}
