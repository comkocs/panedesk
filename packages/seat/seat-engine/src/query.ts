/** Read-only queries advance exclusive cursors even across nonmatching effects. */
import { writeFile, readFile } from 'node:fs/promises'
import type { EngineDecision, EngineQueryRequest, EngineQueryResult, EngineExportRequest, EngineExportResult, EngineVerifyResult, EngineCursor, EngineEffect } from '@panedesk/dsh-seat'
import { canonical, decodeFrame, digest, EngineError, frame } from './journal.ts'

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
  for (const decision of decisions) {
    for (let effectIndex = 0; effectIndex < decision.effects.length; effectIndex++) {
      if (request.cursor && (decision.sequence < request.cursor.sequence
        || (decision.sequence === request.cursor.sequence && effectIndex <= request.cursor.effectIndex))) continue
      if (effects.length === request.limit) return { effects, complete: false, watermark, ...(nextCursor ? { nextCursor } : {}) }
      nextCursor = { nodeId: decision.nodeId, sequence: decision.sequence, effectIndex }
      const effect = decision.effects[effectIndex]
      if (!effect) throw new EngineError('engine-store-corrupt', 'Missing engine effect')
      if (request.nodeId !== undefined && request.nodeId !== decision.nodeId) continue
      if (request.seat !== undefined && request.seat !== effect.seat) continue
      if (request.kinds && !request.kinds.includes(effect.kind)) continue
      if (request.from && decision.observedAt < request.from) continue
      if (request.to && decision.observedAt >= request.to) continue
      effects.push(effect)
    }
  }
  return { effects, complete: true, watermark, ...(nextCursor ? { nextCursor } : {}) }
}
function redact(effect: EngineEffect): EngineEffect {
  if (effect.kind === 'open/intent' || effect.kind === 'open/created' || effect.kind === 'open/configured' || effect.kind === 'open/opening-failed') {
    const { definition: _definition, ...data } = effect.data
    return { ...effect, data: { ...data, ...(data.sources ? { sources: data.sources.map(source => ({ ...source, data: null })) } : {}) } }
  }
  if (effect.kind === 'trigger/accepted' || effect.kind === 'trigger/coalesced' || effect.kind === 'trigger/deduplicated') {
    return { ...effect, data: { ...effect.data, trigger: { ...effect.data.trigger, data: null },
      pending: { ...effect.data.pending, sources: effect.data.pending.sources.map(source => ({ ...source, data: null })) } } }
  }
  if (effect.kind === 'queue/pending') return { ...effect, data: { ...effect.data, sources: effect.data.sources.map(source => ({ ...source, data: null })) } }
  if (effect.kind === 'queue/approved' || effect.kind === 'queue/cancelled') return { ...effect, data: { ...effect.data, pending: { ...effect.data.pending, sources: effect.data.pending.sources.map(source => ({ ...source, data: null })) } } }
  return effect
}
/** Export only selected facts in stable order, preserving frame sequence for offline verification.
 * @param decisions - committed history.
 * @param request - explicit output and raw-data authorization.
 * @returns exported effect count and content digest.
 */
export async function exportEngine(decisions: readonly EngineDecision[], request: EngineExportRequest): Promise<EngineExportResult> {
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
  await writeFile(request.output, text, { flag: 'wx', mode: 0o600 })
  return { status: 'exported', count, digest: digest(text), watermark: decisions.at(-1)?.sequence ?? 0 }
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
