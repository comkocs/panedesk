/** Durable local call and lifecycle accounting with fail-closed writes and trusted wait metering. */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { resolveDshHome } from '@panedesk/dsh-home-paths'
import type {} from '@panedesk/dsh-tools'
import {
  appendUnique, readJournalSnapshot, resolveNodeId, ensureDirectory, importSegments,
  appendArtifact as appendSidecar, finishArtifact as finishSidecar, type JournalOptions,
  appendMessageUnique, JournalViewOwner, readJournalFacts, readJournalEvents, ArtifactAppendCache,
} from './journal.ts'
import { LedgerUnavailableError, WriterLockIdentity } from './lock.ts'
import type { LedgerIndex } from './index-store.ts'
import { foldLedger, foldMessages, joinSessionLedgers, exportMessages } from './projection.ts'
import { loadPriceTable, priceUsage } from './pricing.ts'
import type { LedgerEventId, LedgerNodeId, LedgerInterval, MessageLedgerStore, LedgerMessagePage, LedgerSessionPage } from './types.ts'
import type { MessageQuery } from '@panedesk/dsh-message-delivery'
import { readMessagePage } from './message-reader.ts'
export { LedgerUnavailableError } from './lock.ts'
export { messageEventId, validateEvent as validateLedgerEvent } from './journal.ts'
import { Context, Service } from '@panedesk/cordis'
import type {
  LedgerAppendResult, LedgerArtifactAppend, LedgerArtifactAppendResult,
  LedgerArtifactFinishResult, LedgerArtifactReference, LedgerCallFinish, LedgerCallStart, LedgerEvent,
  LedgerOptions, LedgerWaitCategory, LedgerContext, LedgerRunId, LedgerPriceEntry, LedgerPriceTable,
  LedgerPriceUsageRequest, LedgerPriceUsageResult, LedgerQuery,
  LedgerRunFinish, LedgerRunStart, LedgerSnapshot, LedgerSessionContext,
} from './types.ts'
export type * from './types.ts'
export { loadPriceTable, priceUsage, recomputeUsage, tokenColumns } from './pricing.ts'
export { projectWaits, withoutWaitProjection } from './waits.ts'
export { includeDescendantSessions, foldLedger } from './projection.ts'
export { callWaits } from './call-waits.ts'
import { callWaits } from './call-waits.ts'
export type * from './call-contributor.ts'
import type { CallContributor } from './call-contributor.ts'
import { installCallAccounting } from './call-accounting.ts'

/** Trusted configuration accepted by concrete ledger providers. */
export type Config = LedgerOptions

declare module '@panedesk/cordis' {
  interface Context {
    sessionLedger: SessionLedger
    /** Optional secondary ledger; the local journal remains authoritative. */
    ledgerMirror: {
      append(event: LedgerEvent): void
      snapshot(): Promise<LedgerSnapshot | undefined>
    }
  }
}

/** Durable ledger contract; implementations alone own storage and runtime hooks. */
export abstract class SessionLedger extends Service {
  private readonly registerContributor: (contributor: CallContributor) => () => void
  private compactionOwner = false

  constructor(ctx: Context) {
    super(ctx, 'sessionLedger')
    this.registerContributor = installCallAccounting(ctx, this, () => this.compactionOwner,
      (start, ids) => this.readCallWaits(start, ids))
  }

  protected async readCallWaits(start: LedgerCallStart, ids: readonly NonNullable<LedgerInterval['toolCallId']>[]): Promise<LedgerInterval[]> {
    return callWaits(await this.snapshot({ sessionId: start.sessionId }), start, ids)
  }

  /** Claim compaction facts while leaving physical request accounting with this service.
   * Concurrent owners reject. Without an owner, call accounting records summary facts.
   * @returns Idempotent disposer; capture it in the producing plugin's effect.
   */
  registerCompactionOwner(): () => void {
    const dispose = this.ctx.effect(() => {
      if (this.compactionOwner) throw new Error('Compaction owner is already registered')
      this.compactionOwner = true
      return () => { this.compactionOwner = false }
    })
    return () => { void dispose() }
  }

  /** Register the optional cache contributor on this ledger instance.
   * Concurrent registrations reject, including the same object twice. Capture the returned
   * disposer in the contributing plugin's effect; release prevents future contributions,
   * while calls already prepared retain their contribution through settlement.
   * @param contributor - Cache evidence and admission owner, never a call lifecycle writer.
   * @returns Idempotent disposer releasing only this registration.
   */
  registerCallContributor(contributor: CallContributor): () => void {
    return this.registerContributor(contributor)
  }

  /** Resolve trusted attribution before dispatch.
   * @param request - Explicit session and serving route.
   * @returns Resolved identity and optional frozen reference price.
   */
  abstract resolveCallContext(request: {
    sessionId?: LedgerContext['sessionId']
    provider: string
    model: string
  }): Promise<{ context: LedgerContext; runId: LedgerRunId; price?: LedgerPriceEntry; priceTable?: LedgerPriceTable }>
  /** Bind runtime-owned attribution before publishing a session.
   * @param context - Trusted identity and parent linkage.
   * @returns Disposer removing only this binding.
   */
  abstract bindContext(context: LedgerSessionContext): () => void
  /** Read an in-memory trusted binding.
   * @param sessionId - Local session identity.
   * @returns Bound attribution, or undefined when absent.
   */
  abstract contextFor(sessionId: LedgerSessionContext['sessionId']): LedgerSessionContext | undefined
  /** Persist call intent before network dispatch.
   * @param input - Immutable request and attribution facts.
   * @returns Durable append, replay, or conflict outcome.
   */
  abstract beginCall(input: LedgerCallStart): Promise<LedgerAppendResult>
  /** Commit one terminal call fact.
   * @param input - Observed terminal facts.
   * @returns Durable append, replay, or conflict outcome.
   */
  abstract finishCall(input: LedgerCallFinish): Promise<LedgerAppendResult>
  /** Persist launch intent before child execution.
   * @param input - Reserved identities and trusted dispatch options.
   * @returns Durable launch intent or conflict.
   */
  abstract beginRun(input: LedgerRunStart): Promise<LedgerAppendResult>
  /** Compare and set the terminal run slot.
   * @param input - Normal settlement or verified death observation.
   * @returns First committed terminal fact or append outcome.
   */
  abstract finishRun(input: LedgerRunFinish): Promise<LedgerAppendResult>
  /** Append a uniquely identified runtime fact.
   * @param event - Complete versioned evidence.
   * @returns Synchronized append, replay, or conflict outcome.
   */
  abstract appendEvent(event: LedgerEvent): Promise<LedgerAppendResult>
  /** Register trusted wait classification.
   * @param toolName - Exact runtime tool name.
   * @param category - Trusted wait category.
   * @returns Disposer releasing only this registration.
   */
  abstract registerWaitTool(toolName: string, category: LedgerWaitCategory): () => void
  /** Append a contiguous restricted sidecar fragment.
   * @param input - Immutable identity and exact serialized bytes.
   * @returns Durable reference, replay, or conflict outcome.
   */
  abstract appendArtifact(input: LedgerArtifactAppend): Promise<LedgerArtifactAppendResult>
  /** Close a sidecar durably without changing its contents.
   * @param reference - Last durable fragment reference.
   * @returns Closure acknowledgement for terminal call linkage.
   */
  abstract finishArtifact(reference: LedgerArtifactReference): Promise<LedgerArtifactFinishResult>
  /** Select projections without counting observations as extra calls.
   * @param filter - Business-time and identity selection.
   * @returns Snapshot with completeness and watermark evidence.
   */
  abstract query(filter: LedgerQuery): Promise<LedgerSnapshot>
  /** Read a consistent checkpoint view.
   * @param filter - Optional visibility and session restriction.
   * @returns Revisioned snapshot bounded by watermarks.
   */
  abstract snapshot(filter?: LedgerQuery): Promise<LedgerSnapshot>
  /** Read committed body-free facts for a secondary storage mirror; unsupported providers return no facts.
   * @returns Retained facts and whether their history is complete.
   */
  facts(): Promise<{ events: readonly LedgerEvent[]; complete: boolean }> {
    return Promise.resolve({ events: [], complete: false })
  }
  /** Price observed usage with decimal fixed-point arithmetic.
   * @param request - Frozen price, timestamp, tiers, and usage.
   * @returns Reference amount or explicit coverage gap.
   */
  abstract priceUsage(request: LedgerPriceUsageRequest): LedgerPriceUsageResult
  /** Resolve the persisted local node identity.
   * @returns Stable node identity after synchronization.
   */
  abstract nodeId(): Promise<LedgerNodeId>
  /** Import validated offline node facts.
   * @param source - Local source node directory.
   * @returns Per-fact append, replay, or conflict outcomes.
   */
  abstract importNode(source: string): Promise<readonly LedgerAppendResult[]>
  /** Open the independent message journal without changing call accounting.
   * @returns Body-free message fact storage using the ledger's local node identity.
   */
  messages(): Promise<MessageLedgerStore> {
    return Promise.reject(new LedgerUnavailableError(new Error('Message journal is not provided')))
  }
  /** Project all retained versions before selecting current message states.
   * @param query - Session, creation-time, state, class, age and pagination selection.
   * @returns Message statuses and integrity of the full scan.
   */
  async queryMessages(query: MessageQuery): Promise<LedgerMessagePage> {
    const page = await (await this.messages()).read({})
    return foldMessages(page.events, query, Date.now(), page.complete)
  }
  /** Join both namespaces by Session without adding messages to billable call rows.
   * @param query - Shared Session and half-open time filter; all matching messages are retained.
   * @returns Independent journal views grouped by Session, not an atomic cross-journal snapshot.
   */
  async querySessions(query: Pick<LedgerQuery, 'sessionId' | 'from' | 'to'>): Promise<LedgerSessionPage> {
    const [calls, messages] = await Promise.all([this.query(query), this.queryMessages(query)])
    const joined = joinSessionLedgers(calls, messages)
    return query.sessionId === undefined ? joined : {
      ...joined, sessions: joined.sessions.filter(group => group.sessionId === query.sessionId), unassignedMessages: [],
    }
  }
  /** Export a selected message page without bodies, with an integrity header even when empty.
   * @param query - Message filters and optional page cursor.
   * @returns Schema-versioned JSONL metadata and status records.
   */
  async exportMessages(query: MessageQuery): Promise<string> {
    return exportMessages(await this.queryMessages(query))
  }
}

/** Local journal provider registered under the unchanged sessionLedger service name. */
export class JournalSessionLedger extends SessionLedger {
  private readonly options: JournalOptions
  private readonly home: string
  private readonly freshness: number
  private readonly configuredWaits: Readonly<Record<string, LedgerWaitCategory>>
  private readonly waits = new Map<string, { category: LedgerWaitCategory; owners: Set<symbol> }>()
  private node: Promise<{ root: string; id: LedgerNodeId }> | undefined
  private readonly contexts = new Map<LedgerContext['sessionId'], Map<symbol, LedgerSessionContext>>()
  private readonly artifactCache = new ArtifactAppendCache()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.home = resolveDshHome(config.dshHome)
    const viewOwner = new JournalViewOwner()
    ctx.effect(() => () => { viewOwner.dispose() })
    this.options = {
      viewOwner,
      committed: event => {
        try { ctx.get('ledgerMirror')?.append(event) }
        catch (error) { ctx.logger.warn('Ledger mirror rejected a committed local fact', error) }
      },
      identity: new WriterLockIdentity(),
      lockTimeoutMs: config.lockTimeoutMs ?? 30000,
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
    // Wait accounting is best effort: a busy or unreadable ledger never stops a tool.
    ctx.on('tools/execute', async (exec, next) => {
      if (!exec.agent) return next()
      const category = this.waits.get(exec.name)?.category ?? this.configuredWaits[exec.name] ?? 'unclassified'
      const startedAt = Date.now()
      const interval: LedgerInterval = { kind: category, startedAt, toolCallId: exec.callId }
      let base: { schemaVersion: 1; nodeId: LedgerRunStart['nodeId']; runId: LedgerRunStart['runId']; sessionId: LedgerRunStart['sessionId'] }
      try {
        const snapshot = await this.hotSnapshot({ kind: 'open-runs', sessionId: exec.agent.session.id })
        const run = snapshot.rows.filter(row => row.kind === 'run' && !row.finish).at(-1)
        if (!run || run.kind !== 'run') return next()
        base = { schemaVersion: 1, nodeId: run.start.nodeId, runId: run.start.runId, sessionId: run.start.sessionId }
        await this.appendEvent({ ...base, eventId: `wait/start:${base.runId}:${exec.callId}` as LedgerEventId, observedAt: startedAt, kind: 'wait/start', interval })
      } catch (error) {
        ctx.logger.warn('Local accounting skipped a tool wait', error)
        return next()
      }
      const monotonic = performance.now()
      try { return await next() } finally {
        const endedAt = Date.now()
        await this.appendEvent({ ...base, eventId: `wait/end:${base.runId}:${exec.callId}` as LedgerEventId, observedAt: endedAt, kind: 'wait/end', interval: { ...interval, endedAt, durationMs: performance.now() - monotonic } })
          .catch((error: unknown) => { ctx.logger.warn('Local accounting skipped a tool wait end', error) })
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

  private async hotSnapshot(selection: Parameters<typeof readJournalFacts>[2]): Promise<LedgerSnapshot> {
    const { root, id } = await this.location()
    const facts = await readJournalFacts(root, this.options, selection)
    return foldLedger(facts.events, { asOf: Date.now(), localNodeId: id, observationMaxAgeMs: this.freshness,
      filter: { sessionId: selection.sessionId as LedgerContext['sessionId'] }, complete: facts.complete })
  }

  protected override async readCallWaits(start: LedgerCallStart, ids: readonly NonNullable<LedgerInterval['toolCallId']>[]): Promise<LedgerInterval[]> {
    const snapshot = await this.hotSnapshot({ kind: 'waits', nodeId: start.nodeId,
      sessionId: start.sessionId, runId: start.runId, toolCallIds: ids })
    return callWaits(snapshot, start, ids)
  }

  private async write(event: LedgerEvent | ((index: LedgerIndex) => LedgerEvent), firstTerminalWins = false): Promise<LedgerAppendResult> {
    try {
      const { root } = await this.location()
      return await appendUnique(root, event, this.options, firstTerminalWins)
    } catch (error) { throw new LedgerUnavailableError(error) }
  }

  private findStart(index: LedgerIndex, kind: 'call/start' | 'run/start', id: string): LedgerEvent {
    const start = index.slots.get(JSON.stringify([kind, id]))
    if (!start) throw new LedgerUnavailableError(new Error('Missing or unreadable durable start'))
    return start
  }

  /** Resolve trusted attribution and freeze pricing before a call starts.
   * @param request - explicit session when available; absent sessions use provider-owned auxiliary attribution.
   * @returns runtime identity, residency identity, and optional matching reference price (absent when unpriced).
   */
  async resolveCallContext(request: {
    sessionId?: LedgerContext['sessionId']
    provider: string
    model: string
  }): Promise<{ context: LedgerContext; runId: LedgerRunId; price?: LedgerPriceEntry; priceTable?: LedgerPriceTable }> {
    const priceTable = loadPriceTable(await readFile(new URL('../prices/reference-v1.json', import.meta.url), 'utf8'))
    const matches = priceTable.entries.filter(entry => entry.modelKey === request.model)
    const price = matches.length === 1 ? matches[0] : undefined
    const pricing = { priceTable, ...price === undefined ? {} : { price } }
    if (request.sessionId !== undefined) {
      const bound = this.contextFor(request.sessionId)
      if (bound !== undefined) return { context: bound, runId: bound.runId, ...pricing }
      const snapshot = await this.hotSnapshot({ kind: 'latest-start', sessionId: request.sessionId })
      const starts = snapshot.rows.flatMap(row => row.kind === 'run' || row.kind === 'call' ? [row.start] : [])
        .sort((a, b) => b.startedAt - a.startedAt)
      const start = starts[0]
      if (snapshot.complete && start !== undefined) {
        const { seat, window, taskId, nodeId, identitySource, sessionId, parentSessionId, rootSessionId,
          subagentRunId, remoteSessionId, accountLabel } = start
        return { context: { seat, window, nodeId, identitySource, sessionId, rootSessionId, accountLabel,
          ...taskId === undefined ? {} : { taskId }, ...parentSessionId === undefined ? {} : { parentSessionId },
          ...subagentRunId === undefined ? {} : { subagentRunId }, ...remoteSessionId === undefined ? {} : { remoteSessionId } },
        runId: start.runId, ...pricing }
      }
    }
    const sessionId = request.sessionId ?? 'unknown' as LedgerContext['sessionId']
    return {
      context: { sessionId, rootSessionId: 'unknown' as LedgerContext['sessionId'],
        nodeId: await this.nodeId(), seat: 'free', window: 'free', identitySource: 'free', accountLabel: 'unknown' },
      runId: 'unknown' as LedgerRunId, ...pricing,
    }
  }

  /** Bind trusted attribution before publishing a Session; providers retain it for call accounting.
   * @param context - runtime-owned identity and parent linkage, never Session-header data.
   * @returns scope-owned disposer removing only this binding.
   */
  bindContext(context: LedgerSessionContext): () => void {
    const bound = structuredClone(context)
    const dispose = this.ctx.effect(() => {
      const owners = this.contexts.get(bound.sessionId) ?? new Map<symbol, LedgerSessionContext>()
      const owner = Symbol(bound.sessionId)
      owners.set(owner, bound)
      this.contexts.set(bound.sessionId, owners)
      return () => {
        owners.delete(owner)
        if (!owners.size) this.contexts.delete(bound.sessionId)
      }
    })
    return () => { void dispose() }
  }
  /** Read attribution for delegation or call accounting.
   * @param sessionId - local Session identity.
   * @returns bound context, or undefined when local identity resolution is required.
   */
  contextFor(sessionId: LedgerSessionContext['sessionId']): LedgerSessionContext | undefined {
    const context = Array.from(this.contexts.get(sessionId)?.values() ?? []).at(-1)
    return context === undefined ? undefined : structuredClone(context)
  }

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
    return this.write((index) => {
      const start = this.findStart(index, 'call/start', input.callId)
      return { schemaVersion: 1, eventId: `call/end:${input.callId}` as LedgerEventId, nodeId: start.nodeId, observedAt: input.observedAt, runId: start.runId, sessionId: start.sessionId, callId: input.callId, kind: 'call/end', data: input }
    })
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
    return this.write((index) => {
      const start = this.findStart(index, 'run/start', input.runId)
      return { schemaVersion: 1, eventId: `run/end:${input.runId}` as LedgerEventId, nodeId: start.nodeId, observedAt: input.observedAt, runId: input.runId, sessionId: start.sessionId, kind: 'run/end', data: input }
    }, true)
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
    return appendSidecar(root, input, this.options, this.artifactCache,
      (index) => { this.findStart(index, 'call/start', input.callId) })
  }
  /** Close a sidecar durably; a mismatching reference or a non-final sequence rejects without mutation.
   * Repeating the same closure is idempotent; acknowledgement follows fsync of the closure marker.
   * @param reference - last durable fragment returned by appendArtifact; an empty stream has no closure reference.
   * @returns durable closure acknowledgement suitable for call/end linkage.
   */
  async finishArtifact(reference: LedgerArtifactReference): Promise<LedgerArtifactFinishResult> {
    const { root } = await this.location()
    return finishSidecar(root, reference, this.options, this.artifactCache)
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
    return readJournalSnapshot(root, this.options, {
      asOf: Date.now(), localNodeId: id, observationMaxAgeMs: this.freshness,
      ...filter === undefined ? {} : { filter },
    })
  }
  override async facts(): Promise<{ events: readonly LedgerEvent[]; complete: boolean }> {
    const { root } = await this.location()
    return readJournalEvents(root, this.options)
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

  /** Open body-free message storage outside the call reader's version directory.
   * @returns Store with durable idempotent appends and explicit scan completeness.
   */
  override async messages(): Promise<MessageLedgerStore> {
    const { id } = await this.location()
    const root = join(this.home, 'ledger', 'messages', 'v1', id)
    await ensureDirectory(root)
    return {
      append: async event => appendMessageUnique(root, event, this.options),
      read: async query => readMessagePage(root, this.options, query),
    }
  }
}

export default JournalSessionLedger
