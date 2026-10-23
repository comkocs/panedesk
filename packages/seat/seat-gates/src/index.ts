/** Optional policy provider and existing tool/checkpoint consumers. */
import { Context } from '@panedesk/cordis'
import z from '@panedesk/schemastery'
import { SeatGateService, type GateContext, type GateCriterion, type GateDefinition, type GateResult, type ListSeatGatesRequest, type RegisterSeatWorktreeRequest, type SeatTaskEndedRequest } from '@panedesk/dsh-seat'
import type {} from '@panedesk/dsh-tools'
import type {} from '@panedesk/dsh-compaction'
import { GateRegistry } from './registry.ts'
import { installConsumers } from './consumers.ts'
import { builtinCriterion, validateDefinitions } from './policies.ts'
import { registerWorktree, taskEnded } from './worktree-service.ts'
import { installLifecycle } from './lifecycle.ts'
import { remindChild } from './continuation.ts'
export { GateRegistry } from './registry.ts'
export { checkContinuation } from './continuation.ts'
export { checkPolling, recognizeSleeps } from './polling.ts'
export { checkMemoryWrite, canonicalWritePath } from './memory.ts'
export { WorktreePolicy } from './worktree.ts'
export { inspectWorktree, type GitReader } from './worktree-git.ts'
export { snapshotMemory, compareMemory, type MemorySnapshot } from './memory-audit.ts'
export { buildCheckpoint } from './checkpoint.ts'
export { SeatClock } from './clock.ts'

/** Loader plugin identity. */
export const name = 'seat-gates'
/** Optional providers activate contributions only while available. */
export const inject: string[] = []
/** Deployment-owned policy settings, resolved once at activation. */
export interface Config {
  /** Deployment criteria override built-in definitions with matching identities. */
  definitions: GateDefinition[]
  /** Repeated identical observations allowed before polling is rejected. */
  pollingThreshold: number
  /** Largest recognized shell sleep allowed by the polling criterion. */
  maxSleepSeconds: number
  /** Maximum UTF-8 bytes retained in a compaction checkpoint. */
  checkpointMaxBytes: number
  /** Maximum checkpoint retries after an oversized result. */
  checkpointRetryLimit: number
  /** Tokens reserved for ledger evidence in the checkpoint budget. */
  ledgerCheckpointReserveTokens: number
  /** Maximum total memory file bytes read for one audit snapshot. */
  memoryAuditMaxBytes: number
  /** Maximum memory files read for one audit snapshot. */
  memoryAuditMaxFiles: number
  /** IANA time zone used for policy calendar observations. */
  timeZone: string
}
/** Validated bounded defaults; JSON configuration cannot provide executable criteria. */
export const Config = z.object({
  definitions: z.array(z.object({
    id: z.string().required(), name: z.string().required(),
    hook: z.union(['before-open', 'before-batch-open', 'before-memory-write', 'before-tool-call', 'before-subagent-dispatch', 'after-subagent-return', 'after-compaction']).required(),
    criterion: z.object({ type: z.string().required(), parameters: z.dict(z.any()).default({}) }).required(),
    alternative: z.string().required(), expiresAt: z.union([z.string(), z.const(null)]).default(null),
    enabled: z.boolean().default(true), revision: z.number().step(1).min(1).default(1), order: z.number().default(0),
  })).default([]),
  pollingThreshold: z.number().step(1).min(1).default(3),
  maxSleepSeconds: z.number().min(0).default(600),
  checkpointMaxBytes: z.number().step(1).min(0).default(32768),
  checkpointRetryLimit: z.number().step(1).min(0).default(2),
  ledgerCheckpointReserveTokens: z.number().step(1).min(0).default(512),
  memoryAuditMaxBytes: z.number().step(1).min(1).default(1048576),
  memoryAuditMaxFiles: z.number().step(1).min(1).default(256),
  timeZone: z.string().default('UTC'),
})

class GateProvider extends SeatGateService {
  readonly registry: GateRegistry
  constructor(ctx: Context, config: Config) {
    super(ctx)
    const engine = ctx.get('seatEngine')
    if (!engine) throw new Error('Seat engine is required during provider activation.')
    validateDefinitions(config.definitions)
    const builtins = [
      ['polling', 'before-tool-call'], ['memory', 'before-memory-write'], ['continuation', 'before-subagent-dispatch'],
      ['worktree-client', 'before-open'], ['worktree-settle', 'before-tool-call'], ['worktree-mature', 'before-tool-call'],
    ] as const
    const definitions: GateDefinition[] = builtins.map(([id, hook]) => ({
      id: id as GateDefinition['id'], name: id, hook, criterion: { type: id as GateDefinition['criterion']['type'], parameters: {} },
      alternative: id === 'continuation' ? 'Start a new subagent with the handoff summary.' : 'Use seat_wait or an authorized seat directory tool.',
      expiresAt: null, enabled: true, revision: 1, order: 0,
    }))
    this.registry = new GateRegistry(engine, [
      ...definitions.filter(row => !config.definitions.some(item => item.id === row.id)), ...config.definitions,
    ], Date.now)
    for (const id of ['polling', 'memory', 'continuation', 'required-fields', 'report-first-line', 'pathspec', 'secret-scan',
      'worktree-client', 'worktree-settle', 'worktree-mature', 'seat-choice', 'explicit-batch']) {
      ctx.effect(() => this.registry.register(builtinCriterion(ctx, config, id)))
    }
  }
  register(criterion: GateCriterion): () => void { return this.registry.register(criterion) }
  evaluate(context: GateContext): Promise<readonly GateResult[]> { return this.registry.evaluate(context) }
  async list(request: ListSeatGatesRequest) {
    const snapshots = (await this.registry.snapshots()).filter(row =>
      (request.gateId === undefined || row.definition.id === request.gateId)
      && (request.hook === undefined || row.definition.hook === request.hook))
    return { gates: snapshots.slice(0, request.limit), complete: snapshots.length <= request.limit,
      watermark: Math.max(0, ...snapshots.map(row => row.watermark)) }
  }
  registerWorktree(request: RegisterSeatWorktreeRequest) {
    return registerWorktree(this.ctx, request)
  }
  onTaskEnded(request: SeatTaskEndedRequest) {
    return taskEnded(this.ctx, request)
  }
  remindChild(request: import('@panedesk/dsh-seat').SeatChildThresholdRequest) {
    return remindChild(this.ctx.get('seatReminderHost'), request)
  }
}

/** Install policy only when the seat service and durable engine are both present.
 * @param ctx - reversible plugin owner.
 * @param config - validated policy and checkpoint limits.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['seats', 'seatEngine'], (scope) => {
    const provider = new GateProvider(scope, config)
    installConsumers(scope, config, provider)
    installLifecycle(scope, config)
  })
}
