/** Durable local call and lifecycle accounting with fail-closed writes and trusted wait metering. */
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import type {} from '@panedesk/dsh-tools'
import {
  appendUnique, recoverSegments, resolveNodeId, ensureDirectory, importSegments,
  appendArtifact as appendSidecar, finishArtifact as finishSidecar, type JournalOptions,
} from './journal.ts'
import { withWriterLock, LedgerUnavailableError } from './lock.ts'
import { foldLedger } from './projection.ts'
import { priceUsage } from './pricing.ts'
import type { LedgerEventId, LedgerNodeId, LedgerInterval } from './types.ts'
export { LedgerUnavailableError } from './lock.ts'
import { Context, Service } from '@panedesk/cordis'
import type {
  LedgerAppendResult, LedgerArtifactAppend, LedgerArtifactAppendResult,
  LedgerArtifactFinishResult, LedgerArtifactReference, LedgerCallFinish, LedgerCallStart, LedgerEvent,
  LedgerOptions, LedgerWaitCategory, LedgerContext, LedgerRunId, LedgerPriceEntry,
  LedgerPriceUsageRequest, LedgerPriceUsageResult, LedgerQuery,
  LedgerRunFinish, LedgerRunStart, LedgerSnapshot, LedgerSessionContext,
} from './types.ts'
export type * from './types.ts'

/** Trusted configuration accepted by concrete ledger providers. */
export type Config = LedgerOptions

declare module '@panedesk/cordis' {
  interface Context {
    sessionLedger: SessionLedger
  }
}

/** Durable ledger operations fail closed before model dispatch when the start cannot be committed. */
export class SessionLedger extends Service {
  private readonly options: JournalOptions
  private readonly home: string
  private readonly freshness: number
  private readonly configuredWaits: Readonly<Record<string, LedgerWaitCategory>>
  private readonly waits = new Map<string, { category: LedgerWaitCategory; owners: Set<symbol> }>()
  private node: Promise<{ root: string; id: LedgerNodeId }> | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionLedger')
    this.home = resolveDshHome(config.dshHome)
    this.options = {
      lockTimeoutMs: config.lockTimeoutMs ?? 5000,
      lockRetryMs: config.lockRetryMs ?? 10,
      maxRecordBytes: config.maxRecordBytes ?? 16 * 1024 * 1024,
    }
    this.freshness = config.observationMaxAgeMs ?? 10_000
    for (const value of [this.options.lockTimeoutMs, this.options.lockRetryMs, this.options.maxRecordBytes, this.freshness]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Ledger limits must be positive safe integers')
    }
    this.configuredWaits = { ...config.waitTools }
    for (const category of Object.values(this.configuredWaits)) {
      if (!['sleep', 'external-marker', 'subagent'].includes(category)) throw new Error('Invalid configured wait category')
    }
    ctx.on('tools/execute', async (exec, next) => {
      if (!exec.agent) return next()
      const snapshot = await this.snapshot({ sessionId: exec.agent.session.id })
      const runs = snapshot.rows.filter(row => row.kind === 'run' && !row.finish)
      const run = runs.at(-1)
      if (!run || run.kind !== 'run') throw new LedgerUnavailableError(new Error('Tool execution has no durable run start'))
      const category = this.waits.get(exec.name)?.category ?? this.configuredWaits[exec.name] ?? 'unclassified'
      const startedAt = Date.now()
      const interval: LedgerInterval = { kind: category, startedAt, toolCallId: exec.callId }
      const base = { schemaVersion: 1 as const, nodeId: run.start.nodeId, runId: run.start.runId, sessionId: run.start.sessionId }
      const start = await this.appendEvent({ ...base, eventId: `wait/start:${run.start.runId}:${exec.callId}` as LedgerEventId, observedAt: startedAt, kind: 'wait/start', interval })
      if (start.kind === 'conflict') throw new LedgerUnavailableError(new Error('Conflicting wait start'))
      const monotonic = performance.now()
      let failure: unknown
      try { return await next() } catch (error) { failure = error; throw error } finally {
        const endedAt = Date.now()
        try {
          const end = await this.appendEvent({ ...base, eventId: `wait/end:${run.start.runId}:${exec.callId}` as LedgerEventId, observedAt: endedAt, kind: 'wait/end', interval: { ...interval, endedAt, durationMs: performance.now() - monotonic } })
          if (end.kind === 'conflict') throw new LedgerUnavailableError(new Error('Conflicting wait end'))
        } catch (error) {
          if (failure !== undefined) throw new AggregateError([failure, error], 'Tool execution and local accounting both failed')
          throw error
        }
      }
    })
  }

  private location(): Promise<{ root: string; id: LedgerNodeId }> {
    this.node ??= (async () => {
      const version = join(this.home, 'ledger', 'v1')
      const id = await resolveNodeId(version, this.options)
      const root = join(version, id)
      await ensureDirectory(root)
      return { root, id }
    })()
    return this.node
  }

  private async write(event: LedgerEvent, firstTerminalWins = false): Promise<LedgerAppendResult> {
    try {
      const { root } = await this.location()
      return await appendUnique(root, event, this.options, firstTerminalWins)
    } catch (error) { throw new LedgerUnavailableError(error) }
  }

  private async findStart(kind: 'call/start' | 'run/start', id: string): Promise<LedgerEvent> {
    const { root } = await this.location()
    const scan = await recoverSegments(root, this.options.maxRecordBytes)
    const start = scan.events.find((event) => {
      if (kind === 'call/start' && event.kind === 'call/start') return event.data.callId === id
      if (kind === 'run/start' && event.kind === 'run/start') return event.data.runId === id
      return false
    })
    if (!start || scan.corrupt.length) throw new LedgerUnavailableError(new Error('Missing or unreadable durable start'))
    return start
  }

  /** Resolve trusted attribution and freeze pricing before a call starts.
   * @param request - explicit session when available; absent sessions use provider-owned auxiliary attribution.
   * @returns runtime identity, residency identity, and optional matching reference price (absent when unpriced).
   */
  abstract resolveCallContext(request: {
    sessionId?: LedgerContext['sessionId']
    provider: string
    model: string
  }): Promise<{ context: LedgerContext; runId: LedgerRunId; price?: LedgerPriceEntry }>

  /** Bind trusted attribution before publishing a Session; providers retain it for call accounting.
   * @param context - runtime-owned identity and parent linkage, never Session-header data.
   * @returns scope-owned disposer removing only this binding.
   */
  abstract bindContext(context: LedgerSessionContext): () => void
  /** Read attribution for delegation or call accounting.
   * @param sessionId - local Session identity.
   * @returns bound context, or undefined when local identity resolution is required.
   */
  abstract contextFor(sessionId: LedgerSessionContext['sessionId']): LedgerSessionContext | undefined

  /** Persist one call start before releasing network dispatch.
   * @param input - immutable request and attribution facts.
   * @returns committed or existing start, or an explicit conflicting-payload result.
   */
  async beginCall(input: LedgerCallStart): Promise<LedgerAppendResult> {
    return this.write({ schemaVersion: 1, eventId: `call/start:${input.callId}` as LedgerEventId, nodeId: input.nodeId, observedAt: input.startedAt, runId: input.runId, sessionId: input.sessionId, callId: input.callId, kind: 'call/start', data: input })
  }
  /** Commit at most one terminal fact per call; late evidence never overwrites it.
   * @param input - observed terminal facts.
   * @returns committed or already existing terminal fact, or a conflict.
   */
  async finishCall(input: LedgerCallFinish): Promise<LedgerAppendResult> {
    const start = await this.findStart('call/start', input.callId)
    return this.write({ schemaVersion: 1, eventId: `call/end:${input.callId}` as LedgerEventId, nodeId: start.nodeId, observedAt: input.observedAt, runId: start.runId, sessionId: start.sessionId, callId: input.callId, kind: 'call/end', data: input })
  }
  /** Persist launch intent before permitting child execution.
   * @param input - reserved identities and trusted dispatch options.
   * @returns durable launch intent or conflict.
   */
  async beginRun(input: LedgerRunStart): Promise<LedgerAppendResult> {
    return this.write({ schemaVersion: 1, eventId: `run/start:${input.runId}` as LedgerEventId, nodeId: input.nodeId, observedAt: input.startedAt, runId: input.runId, sessionId: input.sessionId, kind: 'run/start', data: input })
  }
  /** Compare-and-set the terminal run slot; later observations are separate events.
   * @param input - normal settlement or verified death observation.
   * @returns first committed terminal fact, including when another writer won.
   */
  async finishRun(input: LedgerRunFinish): Promise<LedgerAppendResult> {
    const start = await this.findStart('run/start', input.runId)
    return this.write({ schemaVersion: 1, eventId: `run/end:${input.runId}` as LedgerEventId, nodeId: start.nodeId, observedAt: input.observedAt, runId: input.runId, sessionId: start.sessionId, kind: 'run/end', data: input }, true)
  }
  /** Append a uniquely identified fact; equal replays are idempotent and unequal replays conflict.
   * @param event - complete versioned event, containing only runtime-authoritative evidence.
   * @returns durable append outcome after synchronization.
   */
  async appendEvent(event: LedgerEvent): Promise<LedgerAppendResult> {
    return this.write(event)
  }
  /** Register trusted wait metadata; runtime registrations take precedence over configured defaults.
   * Equal registrations may coexist; conflicting live categories are rejected rather than last-writer-wins.
   * @param toolName - exact runtime-registered tool name, never model-supplied category metadata.
   * @param category - trusted wait classification.
   * @returns idempotent disposer releasing only this registration; the last release restores configuration or unclassified.
   */
  registerWaitTool(toolName: string, category: LedgerWaitCategory): () => void {
    const dispose = this.ctx.effect(() => {
      const prior = this.waits.get(toolName)
      if (prior && prior.category !== category) throw new Error('Conflicting live wait tool classification')
      const entry = prior ?? { category, owners: new Set<symbol>() }
      const owner = Symbol(toolName)
      entry.owners.add(owner)
      this.waits.set(toolName, entry)
      return () => {
        entry.owners.delete(owner)
        if (!entry.owners.size) this.waits.delete(toolName)
      }
    })
    return () => { void dispose() }
  }
  /** Append a restricted JSON sidecar fragment uniquely keyed by callId, kind, and seq.
   * A new sequence must be contiguous; gaps, malformed JSON, and new fragments after closure reject.
   * Exact replays remain valid after closure. Success is returned only after file and required directory fsync.
   * @param input - immutable identity and exact serialized content bytes.
   * @returns durable reference, existing reference for equal bytes, or a conflict without overwriting.
   */
  async appendArtifact(input: LedgerArtifactAppend): Promise<LedgerArtifactAppendResult> {
    const { root } = await this.location()
    await this.findStart('call/start', input.callId)
    return appendSidecar(root, input, this.options)
  }
  /** Close a sidecar durably; a mismatching reference or a non-final sequence rejects without mutation.
   * Repeating the same closure is idempotent; acknowledgement follows fsync of the closure marker.
   * @param reference - last durable fragment returned by appendArtifact; an empty stream has no closure reference.
   * @returns durable closure acknowledgement suitable for call/end linkage.
   */
  async finishArtifact(reference: LedgerArtifactReference): Promise<LedgerArtifactFinishResult> {
    const { root } = await this.location()
    return finishSidecar(root, reference, this.options)
  }
  /** Select projections without counting lifecycle or retry observations as extra calls.
   * @param filter - half-open business-time and identity selection.
   * @returns snapshot and explicit completeness/watermark evidence.
   */
  async query(filter: LedgerQuery): Promise<LedgerSnapshot> {
    return this.snapshot(filter)
  }
  /** Read a consistent checkpoint view; absent filter selects all locally visible facts.
   * @param filter - optional visibility and session restriction.
   * @returns revisioned, bounded-by-watermark snapshot.
   */
  async snapshot(filter?: LedgerQuery): Promise<LedgerSnapshot> {
    const { root, id } = await this.location()
    return withWriterLock(join(root, 'writer.lock'), this.options, async () => {
      const scan = await recoverSegments(root, this.options.maxRecordBytes)
      return foldLedger(scan.events, {
        asOf: Date.now(), localNodeId: id, observationMaxAgeMs: this.freshness,
        ...filter === undefined ? {} : { filter },
        complete: scan.complete, watermarks: { [id]: scan.watermark },
      })
    })
  }
  /** Price authoritative usage with decimal fixed-point arithmetic, without inventing missing values.
   * @param request - frozen price entry, timestamp, tier names, and observed usage.
   * @returns reference USD amount or an explicit coverage gap.
   */
  priceUsage(request: LedgerPriceUsageRequest): LedgerPriceUsageResult {
    return priceUsage(request)
  }

  /** Resolve the persisted local random node identity before producers freeze their context.
   * @returns Stable node identity after synchronization.
   */
  async nodeId(): Promise<LedgerNodeId> {
    return (await this.location()).id
  }

  /** Import validated offline node facts without treating historical process observations as live.
   * @param source - Local node directory containing the source events tree.
   * @returns Per-fact append, replay, or conflict outcomes.
   */
  async importNode(source: string): Promise<readonly LedgerAppendResult[]> {
    const { root } = await this.location()
    return importSegments(root, source, this.options)
  }
}

export default SessionLedger
