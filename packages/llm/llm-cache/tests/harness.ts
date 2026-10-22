import { randomUUID, createHash } from 'node:crypto'
import { Context } from '@panedesk/cordis'
import AgentRegistry from '@panedesk/dsh-agent'
import AgentLoop from '@panedesk/dsh-agent-loop'
import SessionStore, { SessionId } from '@panedesk/dsh-session'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SystemPrompt from '@panedesk/dsh-system-prompt'
import ToolRuntime from '@panedesk/dsh-tools'
import LlmRuntime, { LlmAdapter } from '@panedesk/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@panedesk/dsh-llm'
import SessionLedger from '@panedesk/dsh-session-ledger'
import type {
  LedgerAppendResult, LedgerArtifactAppend, LedgerArtifactAppendResult, LedgerArtifactReference,
  LedgerArtifactFinishResult, LedgerCallStart, LedgerCallFinish, LedgerContext, LedgerRunId, LedgerEvent,
  LedgerEventId, LedgerNodeId, LedgerWatermark, LedgerRunStart, LedgerRunFinish,
  LedgerSnapshot, LedgerPriceUsageRequest, LedgerPriceUsageResult,
} from '@panedesk/dsh-session-ledger'
import * as Cache from '../src/index.ts'

export class MemoryLedger extends SessionLedger {
  starts: LedgerCallStart[] = []
  ends: LedgerCallFinish[] = []
  events: LedgerEvent[] = []
  fragments: LedgerArtifactAppend[] = []
  closed: LedgerArtifactReference[] = []
  failStart = false
  failEnd = false
  restored: LedgerSnapshot = { asOf: 0, watermarks: {}, complete: true, rows: [] }
  override resolveCallContext(request: { sessionId?: LedgerContext['sessionId']; provider: string; model: string }) {
    return Promise.resolve({
      context: { sessionId: request.sessionId ?? SessionId('auxiliary'), rootSessionId: request.sessionId ?? SessionId('auxiliary'),
        seat: 'free', window: 'free', nodeId: 'node-a' as LedgerNodeId, identitySource: 'free' as const, accountLabel: 'unknown' },
      runId: 'run-a' as LedgerRunId,
    })
  }
  private result(event: LedgerEvent): LedgerAppendResult {
    return { kind: 'appended', event, watermark: String(this.events.length) as LedgerWatermark }
  }
  private envelope(start: LedgerCallStart) {
    return { schemaVersion: 1 as const, eventId: randomUUID() as LedgerEventId, nodeId: start.nodeId,
      observedAt: Date.now(), sessionId: start.sessionId, runId: start.runId, callId: start.callId }
  }
  override beginCall(input: LedgerCallStart): Promise<LedgerAppendResult> {
    if (this.failStart) return Promise.reject(new Error('start unavailable'))
    this.starts.push(structuredClone(input))
    return Promise.resolve(this.result({ ...this.envelope(input), kind: 'call/start', data: input }))
  }
  override finishCall(input: LedgerCallFinish): Promise<LedgerAppendResult> {
    if (this.failEnd) return Promise.reject(new Error('end unavailable'))
    this.ends.push(structuredClone(input))
    const start = this.starts.find(item => item.callId === input.callId)
    if (start === undefined) return Promise.reject(new Error('missing start'))
    return Promise.resolve(this.result({ ...this.envelope(start), kind: 'call/end', data: input }))
  }
  override beginRun(_input: LedgerRunStart): Promise<LedgerAppendResult> { throw new Error('not used') }
  override finishRun(_input: LedgerRunFinish): Promise<LedgerAppendResult> { throw new Error('not used') }
  override appendEvent(event: LedgerEvent): Promise<LedgerAppendResult> {
    this.events.push(structuredClone(event))
    return Promise.resolve(this.result(event))
  }
  override registerWaitTool(): () => void { return () => {} }
  override appendArtifact(input: LedgerArtifactAppend): Promise<LedgerArtifactAppendResult> {
    JSON.parse(input.content)
    const prior = this.fragments.filter(item => item.callId === input.callId && item.kind === input.kind)
    if (input.seq !== prior.length) return Promise.reject(new Error('noncontiguous sidecar'))
    this.fragments.push(input)
    return Promise.resolve({ kind: 'appended', reference: {
      callId: input.callId, kind: input.kind, seq: input.seq,
      path: `artifacts/${input.callId}/${input.kind}.jsonl`, digest: createHash('sha256').update(input.content).digest('hex'),
    } })
  }
  override finishArtifact(reference: LedgerArtifactReference): Promise<LedgerArtifactFinishResult> {
    this.closed.push(reference)
    return Promise.resolve({ kind: 'finished', reference })
  }
  override query(): Promise<LedgerSnapshot> { return this.snapshot() }
  override snapshot(): Promise<LedgerSnapshot> { return Promise.resolve(this.restored) }
  override priceUsage(request: LedgerPriceUsageRequest): LedgerPriceUsageResult {
    return { state: request.usage === undefined ? 'missing-usage' : 'missing-price', reference: true }
  }
}

export class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  chunks: StreamChunk[] = [
    { type: 'text-delta', index: 0, text: 'answer' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 20 } },
    { type: 'finish', reason: { kind: 'stop' }, responseModel: 'reported-model', responseModelReported: 'different',
      cacheRetention: '1h', cacheWriteTiering: { kind: 'tiered', short: '5m', long: '1h' }, accountLabel: 'route-a' },
  ]
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.requests.push(request)
    yield* this.chunks
  }
}

export async function harness(options: { ledger?: boolean; config?: Partial<Cache.Config> } = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.ledger !== false) await ctx.plugin(MemoryLedger)
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['model-provider'], adapter)
  const config: Cache.Config = {
    policy: { retention: 'default' },
    keepalive: { enabled: false, leadSeconds: 240, minimumIntervalSeconds: 60, maxOutputTokens: 1 },
    concurrency: [{ modelFamily: 'family-a', maxInFlight: 1 }],
    routes: [{ provider: 'model-provider', modelFamily: 'family-a', capability: 'anthropic' }],
    ...options.config,
  }
  await ctx.plugin(Cache, config)
  return { ctx, adapter, ledger: ctx.get('sessionLedger') as MemoryLedger | undefined }
}

export async function consume(ctx: Context, purpose?: GenerateOptions['purpose']): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream({ provider: 'model-provider', model: 'model-a',
    sessionId: SessionId('session-a'), messages: [], system: 'Stable', purpose })) chunks.push(chunk)
  return chunks
}
