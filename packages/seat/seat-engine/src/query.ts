/** Read-only queries advance exclusive cursors even across nonmatching effects. */
import { writeFile, readFile } from 'node:fs/promises'
import type { EngineDecision, EngineQueryRequest, EngineQueryResult, EngineExportRequest, EngineExportResult, EngineVerifyResult, EngineCursor, EngineEffect } from '@panedesk/dsh-seat'
import { canonical, decodeFrame, digest, EngineError, frame } from './journal.ts'
import { triggerRule } from './rules.ts'

/** Query committed effects without executing or importing their operations.
 * @param decisions - verified ordered history.
 * @param request - bounded filters and exclusive cursor.
 * @returns matching facts, completeness and last examined cursor.
 */
export function queryEngine(decisions: readonly EngineDecision[], request: EngineQueryRequest): EngineQueryResult {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new EngineError('invalid-request', 'Query limit must be positive')
  if (request.cursor && (request.cursor.sequence < 0 || request.cursor.effectIndex < 0
    || (decisions[0] && request.cursor.nodeId !== decisions[0].nodeId))) throw new EngineError('query-cursor-invalid', 'Cursor does not belong to this journal')
  const effects: EngineEffect[] = []
  let nextCursor: EngineCursor | undefined
  const watermark = decisions.at(-1)?.sequence ?? 0
  let start = 0, end = decisions.length
  if (request.cursor) {
    // Sequence numbers are ordered, but need not be contiguous.
    while (start < end) {
      const middle = Math.floor((start + end) / 2)
      const decision = decisions[middle]
      if (!decision) throw new EngineError('engine-store-corrupt', 'Missing engine decision')
      if (decision.sequence < request.cursor.sequence) start = middle + 1
      else end = middle
    }
  }
  for (let index = start; index < decisions.length; index++) {
    const decision = decisions[index]
    if (!decision) throw new EngineError('engine-store-corrupt', 'Missing engine decision')
    const firstEffect = request.cursor && decision.sequence === request.cursor.sequence ? request.cursor.effectIndex + 1 : 0
    for (let effectIndex = firstEffect; effectIndex < decision.effects.length; effectIndex++) {
      if (effects.length === request.limit) return { effects, complete: false, watermark, ...(nextCursor ? { nextCursor } : {}) }
      nextCursor = { nodeId: decision.nodeId, sequence: decision.sequence, effectIndex }
      const effect = decision.effects[effectIndex]
      if (!effect) throw new EngineError('engine-store-corrupt', 'Missing engine effect')
      if (request.nodeId !== undefined && request.nodeId !== decision.nodeId) continue
      const data = effect.data
      const seat = effect.seat ?? ('seat' in data ? data.seat : 'pending' in data ? data.pending?.seat
        : 'binding' in data && data.binding.kind === 'seat' ? data.binding.seat
          : 'payload' in data ? data.payload.seat : undefined)
      if (request.seat !== undefined && request.seat !== seat) continue
      if (request.kinds && !request.kinds.includes(effect.kind)) continue
      if (request.from && decision.observedAt < request.from) continue
      if (request.to && decision.observedAt >= request.to) continue
      effects.push(effect)
    }
  }
  return { effects, complete: true, watermark, ...(nextCursor ? { nextCursor } : {}) }
}
/** Remove frozen instruction content and raw source data from public queue pages.
 * @param item - retained queue entry.
 * @returns metadata-only pending entry.
 */
export function redactPending(item: import('@panedesk/dsh-seat').PendingSeatItem): import('@panedesk/dsh-seat').PendingSeatItem {
  const { frozenOpen, ...metadata } = item
  const source = item.sources[0]
  const rule = frozenOpen && source ? triggerRule(frozenOpen.definition, source) : undefined
  const budget = {
    ...(rule?.windowBudgetUsd !== undefined ? { windowBudgetUsd: rule.windowBudgetUsd } : {}),
    ...(rule?.dailyBudgetUsd !== undefined ? { dailyBudgetUsd: rule.dailyBudgetUsd } : {}),
  }
  const nodeId = frozenOpen?.nodeWorkChain?.route.targetNodeId
  return { ...metadata,
    ...(frozenOpen ? { windowName: frozenOpen.title } : {}),
    ...(nodeId !== undefined ? { nodeId } : {}),
    ...(Object.keys(budget).length ? { budget } : {}),
    sources: item.sources.map(source => ({ ...source, data: null })) }
}
/** Remove instruction bodies and raw source data from a public effect.
 * @param effect - Committed effect.
 * @returns Metadata-only effect with the original identity.
 */
export function redact(effect: EngineEffect): EngineEffect {
  if (effect.kind === 'open/intent' || effect.kind === 'open/created' || effect.kind === 'open/configured' || effect.kind === 'open/opening-failed') {
    const { definition: _definition, frozenOpening: _frozenOpening, ...data } = effect.data
    return { ...effect, data: { ...data, ...(data.sources ? { sources: data.sources.map(source => ({ ...source, data: null })) } : {}) } }
  }
  if (effect.kind === 'trigger/accepted' || effect.kind === 'trigger/coalesced' || effect.kind === 'trigger/deduplicated') {
    return { ...effect, data: { ...effect.data, trigger: { ...effect.data.trigger, data: null },
      pending: redactPending(effect.data.pending) } }
  }
  if (effect.kind === 'queue/pending') return { ...effect, data: redactPending(effect.data) }
  if (effect.kind === 'window/replacement' && effect.data.pending) return { ...effect,
    data: { ...effect.data, pending: redactPending(effect.data.pending) } }
  if (effect.kind === 'queue/cancelled' && effect.data.cancellation) {
    const { reason: _reason, ...cancellation } = effect.data.cancellation
    return { ...effect, data: { ...effect.data, cancellation, pending: redactPending(effect.data.pending) } }
  }
  if (effect.kind === 'queue/approved' || effect.kind === 'queue/cancelled') return { ...effect, data: { ...effect.data, pending: redactPending(effect.data.pending) } }
  return effect
}
/** Export only selected facts in stable order, preserving frame sequence for offline verification.
 * @param decisions - committed history.
 * @param request - explicit output and raw-data authorization.
 * @returns exported effect count and content digest.
 */
export async function exportEngine(decisions: readonly EngineDecision[], request: EngineExportRequest): Promise<EngineExportResult> {
  const { content, ...result } = serializeEngine(decisions, request)
  await writeFile(request.output, content, { flag: 'wx', mode: 0o600 })
  return result
}
/** Serialize selected facts without writing any file.
 * @param decisions - verified ordered history.
 * @param request - selection and explicit raw-data authorization.
 * @returns stable JSONL content, count, digest and watermark.
 */
export function serializeEngine(decisions: readonly EngineDecision[], request: EngineExportRequest): Extract<EngineExportResult, { status: 'exported' }> & { content: string } {
  const selected = new Set(queryEngine(decisions, request.query).effects.map(effect => effect.eventId))
  const seen = new Map<string, string>()
  let count = 0
  const output: string[] = []
  for (const decision of decisions) {
    const effects = decision.effects.filter(effect => selected.has(effect.eventId)).filter((effect) => {
      const checksum = digest(effect), previous = seen.get(effect.eventId)
      if (previous && previous !== checksum) throw new EngineError('export-event-conflict', 'Export event identity conflicts')
      if (previous) return false
      seen.set(effect.eventId, checksum); count++; return true
    }).map(effect => request.authorizationRef ? effect : redact(effect))
    if (!effects.length) continue
    const { digest: _digest, byteLength: _length, ...body } = decision
    output.push(canonical(frame({ ...body, effects })))
  }
  const text = output.length ? `${output.join('\n')}\n` : ''
  return { status: 'exported', content: text, count, digest: digest(text), watermark: decisions.at(-1)?.sequence ?? 0 }
}
/** Verify an offline export without publishing its resources or Sessions.
 * @param input - explicit file path.
 * @param maxBytes - complete-frame limit.
 * @returns integrity and preserved-tail evidence.
 */
export async function verifyEngine(input: string, maxBytes: number): Promise<EngineVerifyResult> {
  const text = await readFile(input, 'utf8'), lines = text.split('\n'), tail = lines.pop()
  let watermark = 0, count = 0
  const seen = new Map<string, string>()
  for (const line of lines) {
    const decision = decodeFrame(line, maxBytes)
    if (decision.sequence <= watermark) throw new EngineError('engine-store-corrupt', 'Offline frame order is invalid')
    for (const effect of decision.effects) {
      const previous = seen.get(effect.eventId), checksum = digest(effect)
      if (previous !== undefined && previous !== checksum) throw new EngineError('export-event-conflict', 'Offline event identity conflicts')
      seen.set(effect.eventId, checksum)
    }
    watermark = decision.sequence; count++
  }
  return { status: 'verified', decisions: count, watermark, tail: tail ? 'fragment-preserved' : 'complete' }
}
