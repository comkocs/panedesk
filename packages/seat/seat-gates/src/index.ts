/** Optional policy provider and existing tool/checkpoint consumers. */
import { Context } from '@panedesk/cordis'
import z from '@panedesk/schemastery'
import { SeatGateService, type GateContext, type GateCriterion, type GateDefinition, type GateResult, type ListSeatGatesRequest, type RegisterSeatWorktreeRequest, type SeatTaskEndedRequest } from '@panedesk/dsh-seat'
import type {} from '@panedesk/dsh-tools'
import type {} from '@panedesk/dsh-compaction'
import { GateRegistry } from './registry.ts'
import { installConsumers } from './consumers.ts'
import { builtinCriterion } from './policies.ts'
export { GateRegistry } from './registry.ts'
export { checkContinuation } from './continuation.ts'
export { checkPolling, recognizeSleeps } from './polling.ts'
export { checkMemoryWrite, canonicalWritePath } from './memory.ts'
export { WorktreePolicy } from './worktree.ts'
export { buildCheckpoint } from './checkpoint.ts'
export { SeatClock } from './clock.ts'

/** Loader plugin identity. */
export const name = 'seat-gates'
/** Optional providers activate contributions only while available. */
export const inject: string[] = []
/** Deployment-owned policy settings, resolved once at activation. */
export interface Config {
  definitions: GateDefinition[]
  pollingThreshold: number
  maxSleepSeconds: number
  checkpointMaxBytes: number
  checkpointRetryLimit: number
  ledgerCheckpointReserveTokens: number
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
})

class GateProvider extends SeatGateService {
  readonly registry: GateRegistry
  constructor(ctx: Context, config: Config) {
    super(ctx)
    const engine = ctx.get('seatEngine')!
    const builtins = [
      ['polling', 'before-tool-call'], ['memory', 'before-memory-write'], ['continuation', 'before-subagent-dispatch'],
    ] as const
    const definitions: GateDefinition[] = builtins.map(([id, hook]) => ({
      id: id as GateDefinition['id'], name: id, hook, criterion: { type: id as GateDefinition['criterion']['type'], parameters: {} },
      alternative: id === 'continuation' ? 'Start a new subagent with the handoff summary.' : 'Use seat_wait or an authorized seat directory tool.',
      expiresAt: null, enabled: true, revision: 1, order: 0,
    }))
    this.registry = new GateRegistry(engine, [...definitions.filter(row => !config.definitions.some(item => item.id === row.id)), ...config.definitions], Date.now)
    for (const id of ['polling', 'memory', 'continuation', 'required-fields', 'report-first-line', 'pathspec', 'secret-scan']) {
      ctx.effect(() => this.registry.register(builtinCriterion(ctx, config, id)))
    }
  }
  register(criterion: GateCriterion): () => void { return this.registry.register(criterion) }
  evaluate(context: GateContext): Promise<readonly GateResult[]> { return this.registry.evaluate(context) }
  async list(request: ListSeatGatesRequest) {
    const snapshots = (await this.registry.snapshots()).filter(row => (request.gateId === undefined || row.definition.id === request.gateId) && (request.hook === undefined || row.definition.hook === request.hook))
    return { gates: snapshots.slice(0, request.limit), complete: snapshots.length <= request.limit, watermark: Math.max(0, ...snapshots.map(row => row.watermark)) }
  }
  async registerWorktree(_request: RegisterSeatWorktreeRequest) {
    return unavailableWorktree()
  }
  async onTaskEnded(_request: SeatTaskEndedRequest) {
    return unavailableWorktree()
  }
}

function unavailableWorktree(): import('@panedesk/dsh-seat').SeatRejected {
  return { status: 'rejected', error: { code: 'worktree-unverified', message: 'No authoritative worktree registry is installed.', alternative: 'Register a verified worktree provider before applying worktree policy.', retryable: false, effectState: 'none' } }
}

/** Install policy only when the seat service and durable engine are both present.
 * @param ctx - reversible plugin owner.
 * @param config - validated policy and checkpoint limits.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['seats', 'seatEngine'], scope => {
    const provider = new GateProvider(scope, config)
    installConsumers(scope, config, provider)
  })
}
