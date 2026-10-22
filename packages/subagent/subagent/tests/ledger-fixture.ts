/** In-memory implementation of the public ledger contract for local runtime tests. */
import { randomUUID } from 'node:crypto'
import { brandString } from '@panedesk/dsh-brand'
import { SessionId } from '@panedesk/dsh-session'
import { SessionLedger } from '@panedesk/dsh-session-ledger'
import type { LedgerAppendResult, LedgerArtifactAppend, LedgerArtifactAppendResult, LedgerArtifactFinishResult, LedgerArtifactReference, LedgerCallFinish, LedgerCallStart, LedgerEvent, LedgerEventId, LedgerNodeId, LedgerPriceUsageRequest, LedgerPriceUsageResult, LedgerQuery, LedgerRunFinish, LedgerRunId, LedgerRunStart, LedgerSnapshot, LedgerWaitCategory, LedgerWatermark } from '@panedesk/dsh-session-ledger'

export class MemoryLedger extends SessionLedger {
  readonly events: LedgerEvent[] = []
  readonly starts: LedgerRunStart[] = []
  readonly finishes: LedgerRunFinish[] = []
  failStart = false
  failDenied = false
  denyBarrier?: Promise<void>
  beginCall(_input: LedgerCallStart): Promise<LedgerAppendResult> { throw new Error('Unexpected model accounting') }
  finishCall(_input: LedgerCallFinish): Promise<LedgerAppendResult> { throw new Error('Unexpected model accounting') }
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
    this.events.push(event)
    return { kind: 'appended', event, watermark: brandString<LedgerWatermark>(String(this.events.length)) }
  }
  registerWaitTool(_name: string, _category: LedgerWaitCategory): () => void { return () => undefined }
  appendArtifact(_input: LedgerArtifactAppend): Promise<LedgerArtifactAppendResult> { throw new Error('Unexpected artifact') }
  finishArtifact(_reference: LedgerArtifactReference): Promise<LedgerArtifactFinishResult> { throw new Error('Unexpected artifact') }
  query(filter: LedgerQuery): Promise<LedgerSnapshot> { return this.snapshot(filter) }
  snapshot(filter?: LedgerQuery): Promise<LedgerSnapshot> {
    return Promise.resolve({ asOf: Date.now(), watermarks: {}, complete: true,
      rows: this.starts.filter(start => filter?.sessionId === undefined || start.sessionId === filter.sessionId)
        .map(start => ({ kind: 'run', start, liveness: 'unknown' })) })
  }
  priceUsage(_request: LedgerPriceUsageRequest): LedgerPriceUsageResult { throw new Error('Unexpected pricing') }
  private envelope(start: LedgerRunStart) {
    return { schemaVersion: 1 as const, eventId: brandString<LedgerEventId>(randomUUID()), nodeId: start.nodeId,
      observedAt: Date.now(), runId: start.runId, sessionId: start.sessionId }
  }
}

/** Seed trusted parent identity without depending on a concrete persistence provider. */
export async function seedParentLedger(ledger: MemoryLedger, sessionId = SessionId('parent')): Promise<void> {
  await ledger.beginRun({ runId: brandString<LedgerRunId>('parent-run'), sessionId, rootSessionId: sessionId,
    nodeId: brandString<LedgerNodeId>('node-a'), seat: 'seat-a', window: 'window-a', taskId: 'task-a',
    identitySource: 'startup', accountLabel: 'unknown', startedAt: Date.now(), launchState: 'started', deliveryPaths: [] })
}
