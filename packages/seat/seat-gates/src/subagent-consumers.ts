/** Optional dispatch checks leave capacity, delivery and activation cleanup with their existing owners. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'
import type { SessionId } from '@panedesk/dsh-session'
import type { GateContext, SeatGateService, SeatJson, SeatOperationId, SeatContextUsage } from '@panedesk/dsh-seat'
import type {} from '@panedesk/dsh-subagent'
import type {} from '@panedesk/dsh-session-ledger'
import type {} from '@panedesk/dsh-session-query'
import type {} from '@panedesk/dsh-compaction'

/** Attach policies independently from optional admission and notification providers.
 * @param ctx - reversible seat-gates scope.
 * @param gates - durable gate evaluator.
 */
export function installSubagentConsumers(ctx: Context, gates: SeatGateService): void {
  const read = ctx.get('seatLocalRead')
  const engine = ctx.get('seatEngine')
  const seats = ctx.get('seats')
  if (!read || !engine || !seats) throw new Error('Subagent policies require local seat providers.')
  const base = async (parent: Agent, id: string) => {
    const binding = await read.binding({ sessionId: parent.id })
    if (binding !== null && 'status' in binding) throw new Error(binding.error.alternative)
    const nodeId = binding?.nodeId ?? (await engine.nodeStatus()).nodeId
    return { callId: id as GateContext['callId'], operationId: id as SeatOperationId,
      nodeId, seat: binding?.kind === 'seat' ? binding.seat : null, sessionId: parent.id,
      parentSessionId: parent.id, observedAt: new Date().toISOString() }
  }
  const check = async (context: GateContext) => {
    const denial = (await gates.evaluate(context)).find(result => result.outcome === 'deny')
    if (denial?.outcome === 'deny') throw new Error(`${denial.reason.code}: ${denial.reason.message} ${denial.alternative}`)
  }
  ctx.provide('subagentDispatch', {
    start: async (spec) => {
      await check({ ...await base(spec.request.parent, `gate:subagent:start:${randomUUID()}`),
        hook: 'before-subagent-dispatch', kind: 'start', childSessionId: spec.childId ?? null,
        request: { provider: spec.provider, label: spec.label, prompt: json(spec.request.prompt),
          ...spec.request.agentPreset === undefined ? {} : { agentPreset: spec.request.agentPreset } } })
    },
    continue: async (parent, childId) => {
      const facts = await base(parent, `gate:subagent:continue:${randomUUID()}`)
      const definition = facts.seat === null ? undefined : await seats.resolve(facts.seat)
      await check({ ...facts, hook: 'before-subagent-dispatch', kind: 'continue', childSessionId: childId, request: {},
        ...definition === undefined || 'status' in definition ? {} : {
          continuationEvidence: await continuationEvidence(ctx, childId, definition.subagentContextThresholdTokens),
        } })
    },
    returned: async (parent, childId, runId, result) => {
      await gates.evaluate({ ...await base(parent, `gate:subagent:return:${runId}`),
        hook: 'after-subagent-return', childSessionId: childId,
        result: result.output.filter(block => block.type === 'text').map(block => block.text).join('\n') })
    },
  })
}

async function continuationEvidence(ctx: Context, childId: SessionId, thresholdTokens: number) {
  const observedAt = new Date().toISOString()
  const [ledger, saved] = await Promise.all([
    ctx.get('sessionLedger')?.query({ sessionId: childId }).catch((_error: unknown) => undefined),
    // Missing or unreadable child evidence must refuse continuation rather than infer safety.
    ctx.get('sessionQuery')?.readSession(childId).catch((_error: unknown) => undefined),
  ])
  const call = ledger?.rows.findLast(row => row.kind === 'call' && row.start.purpose === 'conversation' && row.finish !== undefined)
  const cache = call?.kind === 'call' ? call.finish?.cache ?? call.start.cache : undefined
  let context: SeatContextUsage = { status: 'unknown', observedAt }
  if (ledger?.complete && saved && call?.kind === 'call' && call.finish) {
    const compactions = saved.events.filter(event => event.type === 'compaction/end' && event.data.error === undefined)
    const values = [call.finish.usage?.inputTokens, call.finish.usage?.cacheReadTokens, call.finish.usage?.cacheWriteTokens]
    if (call.finish.observedAt > (compactions.at(-1)?.time ?? 0)
      && values.every(value => value !== undefined && Number.isFinite(value) && value >= 0)) {
      context = { status: 'known', observedAt, source: 'last-call-usage', estimated: true,
        tokens: values.reduce<number>((sum, value) => sum + (value ?? 0), 0),
        contextEpoch: new Set(compactions.map(event => event.type === 'compaction/end' ? event.data.compactionId : '')).size }
    }
  }
  return { thresholdTokens, context, cache: {
    observedAt, lastActivityAt: cache?.lastCacheEvidenceAt === undefined ? null : new Date(cache.lastCacheEvidenceAt).toISOString(),
    cacheTtlMs: cache?.ttlSeconds === undefined ? null : cache.ttlSeconds * 1000,
    prefixDigest: cache?.prefixFingerprint === undefined ? null : cache.prefixFingerprint as import('@panedesk/dsh-seat').SeatDigest,
    reusableRequest: ledger?.complete === true && cache?.prefixFingerprint !== undefined,
  } }
}

function json(value: object): SeatJson {
  return JSON.parse(JSON.stringify(value)) as SeatJson
}
