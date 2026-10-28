/** In-memory implementation of the public ledger contract for local runtime tests. */
import { createHash, randomUUID } from 'node:crypto'
import { brandString } from '@panedesk/dsh-brand'
import { SessionId } from '@panedesk/dsh-session'
import { priceUsage, SessionLedger } from '@panedesk/dsh-session-ledger'
import type { LedgerAppendResult, LedgerArtifactAppend, LedgerArtifactAppendResult, LedgerArtifactFinishResult, LedgerArtifactReference, LedgerCallFinish, LedgerCallStart, LedgerEvent, LedgerEventId, LedgerNodeId, LedgerPriceUsageRequest, LedgerPriceUsageResult, LedgerQuery, LedgerRunFinish, LedgerRunId, LedgerRunStart, LedgerSnapshot, LedgerWaitCategory, LedgerWatermark } from '@panedesk/dsh-session-ledger'

export class MemoryLedger extends SessionLedger {
  async resolveCallContext(request: Parameters<SessionLedger['resolveCallContext']>[0]): ReturnType<SessionLedger['resolveCallContext']> {
    const context = request.sessionId === undefined ? undefined : this.contextFor(request.sessionId)
    if (context === undefined) throw new Error('Model accounting requires a bound test session')
    return { context, runId: context.runId }
  }
  private readonly contexts = new Map<SessionId, Parameters<SessionLedger['bindContext']>[0]>()
  bindContext(context: Parameters<SessionLedger['bindContext']>[0]): () => void {
    const prior = this.contexts.get(context.sessionId)
    this.contexts.set(context.sessionId, context)
    return () => { if (prior === undefined) this.contexts.delete(context.sessionId); else this.contexts.set(context.sessionId, prior) }
  }
  contextFor(sessionId: SessionId): ReturnType<SessionLedger['contextFor']> { return this.contexts.get(sessionId) }
  nodeId(): Promise<LedgerNodeId> { return Promise.resolve(brandString<LedgerNodeId>('node-a')) }
  importNode(_source: string): ReturnType<SessionLedger['importNode']> { throw new Error('Unexpected import') }
  readonly events: LedgerEvent[] = []
  readonly starts: LedgerRunStart[] = []
  readonly finishes: LedgerRunFinish[] = []
  failStart = false
  failDenied = false
  denyBarrier?: Promise<void>
  beginCall(input: LedgerCallStart): Promise<LedgerAppendResult> {
    return this.appendEvent({ ...this.envelope(input), eventId: brandString<LedgerEventId>(`call/start:${input.callId}`),
      callId: input.callId, kind: 'call/start', data: input })
  }
  finishCall(input: LedgerCallFinish): Promise<LedgerAppendResult> {
    const start = this.events.find(event => event.kind === 'call/start' && event.data.callId === input.callId)
    if (start?.kind !== 'call/start') throw new Error('Unknown call')
    return this.appendEvent({ ...this.envelope(start.data), eventId: brandString<LedgerEventId>(`call/end:${input.callId}`),
      callId: input.callId, kind: 'call/end', data: input })
  }
  async beginRun(input: LedgerRunStart): Promise<LedgerAppendResult> {
    if (this.failStart) throw new Error('Ledger synchronization failed')
    this.starts.push(input)
    return this.appendEvent({ ...this.envelope(input), kind: 'run/start', data: input })
  }
  async finishRun(input: LedgerRunFinish): Promise<LedgerAppendResult> {
    const start = this.starts.find(item => item.runId === input.runId)
    if (start === undefined) throw new Error('Unknown run')
    this.finishes.push(input)
    return this.appendEvent({ ...this.envelope(start), kind: 'run/end', data: input })
  }
  async appendEvent(event: LedgerEvent): Promise<LedgerAppendResult> {
    if (event.kind === 'policy/denied') {
      await this.denyBarrier
      if (this.failDenied) throw new Error('Denied fact synchronization failed')
    }
    const prior = this.events.find(item => item.eventId === event.eventId)
    if (prior !== undefined) {
      const digest = (value: LedgerEvent) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
      if (digest(prior) !== digest(event)) return { kind: 'conflict', eventId: event.eventId,
        existingDigest: digest(prior), incomingDigest: digest(event) }
      return { kind: 'existing', event: prior, watermark: brandString<LedgerWatermark>(String(this.events.length)) }
    }
    this.events.push(event)
    return { kind: 'appended', event, watermark: brandString<LedgerWatermark>(String(this.events.length)) }
  }
  registerWaitTool(_name: string, _category: LedgerWaitCategory): () => void { return () => undefined }
  private readonly artifacts = new Map<string, { fragments: LedgerArtifactReference[]; closed: boolean }>()
  async appendArtifact(input: LedgerArtifactAppend): Promise<LedgerArtifactAppendResult> {
    if (!this.events.some(event => event.kind === 'call/start' && event.data.callId === input.callId)) throw new Error('Unknown call')
    JSON.parse(input.content)
    const path = `${input.callId}/${input.kind}`
    const stream = this.artifacts.get(path) ?? { fragments: [], closed: false }
    const digest = createHash('sha256').update(input.content).digest('hex')
    const { callId, kind, seq } = input
    const reference = { callId, kind, seq, path, digest }
    const prior = stream.fragments[seq]
    if (prior !== undefined) return prior.digest === digest ? { kind: 'existing', reference: prior }
      : { kind: 'conflict', key: { callId, kind, seq }, existingDigest: prior.digest, incomingDigest: digest }
    if (stream.closed || seq !== stream.fragments.length) throw new Error('Invalid artifact sequence')
    stream.fragments.push(reference)
    this.artifacts.set(path, stream)
    return { kind: 'appended', reference }
  }
  async finishArtifact(reference: LedgerArtifactReference): Promise<LedgerArtifactFinishResult> {
    const stream = this.artifacts.get(reference.path)
    const last = stream?.fragments.at(-1)
    if (stream === undefined || JSON.stringify(last) !== JSON.stringify(reference)) throw new Error('Invalid artifact closure')
    const kind = stream.closed ? 'existing' : 'finished'
    stream.closed = true
    return { kind, reference }
  }
  query(filter: LedgerQuery): Promise<LedgerSnapshot> { return this.snapshot(filter) }
  snapshot(filter?: LedgerQuery): Promise<LedgerSnapshot> {
    return Promise.resolve({ asOf: Date.now(), watermarks: {}, complete: true,
      rows: [
        ...this.starts.filter(start => filter?.sessionId === undefined || start.sessionId === filter.sessionId)
          .map(start => ({ kind: 'run' as const, start, liveness: 'unknown' as const,
            ...this.finishes.find(finish => finish.runId === start.runId) === undefined ? {}
              : { finish: this.finishes.find(finish => finish.runId === start.runId)! } })),
        ...this.events.flatMap((event) => {
          if (event.kind !== 'call/start' || (filter?.sessionId !== undefined && event.sessionId !== filter.sessionId)) return []
          const end = this.events.find(candidate => candidate.kind === 'call/end' && candidate.data.callId === event.data.callId)
          return [{ kind: 'call' as const, start: event.data, ...end?.kind === 'call/end' ? { finish: end.data } : {} }]
        }),
      ] })
  }
  priceUsage(request: LedgerPriceUsageRequest): LedgerPriceUsageResult { return priceUsage(request) }
  private envelope(start: LedgerRunStart | LedgerCallStart) {
    return { schemaVersion: 1 as const, eventId: brandString<LedgerEventId>(randomUUID()), nodeId: start.nodeId,
      observedAt: Date.now(), runId: start.runId, sessionId: start.sessionId }
  }
}

/** Seed trusted parent identity without depending on a concrete persistence provider. */
export async function seedParentLedger(ledger: MemoryLedger, sessionId = SessionId('parent')): Promise<void> {
  ledger.bindContext({ runId: brandString<LedgerRunId>('parent-run'), sessionId, rootSessionId: sessionId,
    nodeId: brandString<LedgerNodeId>('node-a'), seat: 'seat-a', window: 'window-a', taskId: 'task-a',
    identitySource: 'startup', accountLabel: 'unknown' })
}
