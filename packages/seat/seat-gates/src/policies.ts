/** Installed criterion implementations consume trusted executor facts, not executable JSON. */
import type { Context } from '@panedesk/cordis'
import type { GateCriterion, GateContext, GateDefinition, GateResult, SeatFailure } from '@panedesk/dsh-seat'
import type { Config } from './index.ts'
import { checkContinuation } from './continuation.ts'
import { checkPolling, type PollingState } from './polling.ts'
import { canonicalWritePath, checkMemoryWrite } from './memory.ts'

/** Create a built-in evaluator; registry publication remains the single audit owner.
 * @param ctx - optional service access.
 * @param config - resolved thresholds.
 * @param id - installed criterion identity.
 * @returns evaluator without mutable counter state.
 */
export function builtinCriterion(ctx: Context, config: Config, id: string): GateCriterion {
  return { id: id as GateCriterion['id'], async evaluate(context, definition) {
    let failure: SeatFailure | null = null
    if (id === 'continuation' && context.hook === 'before-subagent-dispatch' && context.kind === 'continue') {
      const evidence = context.continuationEvidence
      failure = evidence === undefined ? refusal('evidence-unavailable', 'Child-owned continuation evidence is unavailable.', 'Start a new subagent with the handoff summary.')
        : checkContinuation(evidence.cache, evidence.context, evidence.thresholdTokens, Date.now())
    } else if (id === 'polling' && context.hook === 'before-tool-call') {
      const engine = ctx.get('seatEngine')!
      let cursor: import('@panedesk/dsh-seat').EngineCursor | undefined
      let state: PollingState | undefined
      for (;;) {
        const page = await engine.query({ kinds: ['gate/hit'], limit: 1000, ...cursor === undefined ? {} : { cursor } })
        for (const effect of page.effects) {
          if (effect.kind !== 'gate/hit' || effect.data.definition.id !== definition.id || effect.data.definition.revision !== definition.revision) continue
          const previous = effect.data.context
          if (previous.hook === 'before-tool-call' && previous.sessionId === context.sessionId) state = checkPolling(previous, state, config.pollingThreshold, config.maxSleepSeconds).state
        }
        if (page.complete) break
        if (page.nextCursor === undefined) throw new Error('Polling history is incomplete.')
        cursor = page.nextCursor
      }
      failure = checkPolling(context, state, config.pollingThreshold, config.maxSleepSeconds).failure
    } else if (id === 'memory' && context.hook === 'before-memory-write' && context.syntax === 'certain') {
      const seats = ctx.get('seats')!
      const roots: { path: string; seats: import('@panedesk/dsh-seat').SeatName[] }[] = []
      let cursor: string | undefined
      for (;;) {
        const page = await seats.definitions(cursor === undefined ? {} : { cursor })
        for (const definition of page.definitions) {
          for (const path of definition.memoryDirectories) {
            const canonical = await canonicalWritePath(path, context.cwd ?? '/')
            const existing = roots.find(root => root.path === canonical)
            if (existing) existing.seats.push(definition.seat)
            else roots.push({ path: canonical, seats: [definition.seat] })
          }
        }
        if (page.complete) break
        if (page.nextCursor === undefined) throw new Error('Memory directory catalog is incomplete.')
        cursor = page.nextCursor
      }
      failure = checkMemoryWrite(await canonicalWritePath(context.targetPath, context.cwd ?? '/'), context.seat, roots)
    } else {
      failure = checkCustom(id, context, definition)
    }
    const facts = { gateId: definition.id, revision: definition.revision, hitCount: 0, expiresAt: definition.expiresAt, audit: 'recorded' as const }
    if (!failure) return { ...facts, outcome: 'allow' }
    const result: GateResult = context.hook === 'after-subagent-return'
      ? { ...facts, outcome: 'observe', reason: failure.message, alternative: failure.alternative }
      : { ...facts, outcome: 'deny', reason: failure, alternative: failure.alternative }
    return result
  } }
}

function refusal(code: SeatFailure['code'], message: string, alternative: string): SeatFailure {
  return { code, message, alternative, retryable: false, effectState: 'none' }
}

function checkCustom(id: string, context: GateContext, definition: GateDefinition): SeatFailure | null {
  const parameters = definition.criterion.parameters
  if (id === 'required-fields' && context.hook === 'before-subagent-dispatch') {
    const required = parameters.required
    if (!Array.isArray(required) || required.some(key => typeof key !== 'string')) throw new Error('required-fields requires a string list.')
    const missing = required.filter(key => typeof key === 'string' && (context.request[key] === undefined || context.request[key] === ''))
    if (missing.length) return refusal('gate-denied', `Missing dispatch fields: ${missing.join(', ')}.`, definition.alternative)
  }
  if (id === 'report-first-line' && context.hook === 'after-subagent-return') {
    if (typeof parameters.prefix !== 'string') throw new Error('report-first-line requires a prefix.')
    if (typeof context.result !== 'string' || !context.result.split('\n')[0]!.startsWith(parameters.prefix)) return refusal('gate-denied', 'The return report needs manual format review.', definition.alternative)
  }
  if (context.hook === 'before-tool-call') {
    const command = context.arguments.command
    if (id === 'pathspec' && typeof command === 'string' && /(?:^|[;&|]\s*)git\s+(?:add\s+(?:-A|--all|\.)|commit\s+(?:-a|--all))(?:\s|$)/.test(command)) return refusal('gate-denied', 'Use explicit paths for this Git mutation.', definition.alternative)
    if (id === 'secret-scan') {
      const text = context.arguments.content
      if (typeof text !== 'string') return null
      if (typeof parameters.maxBytes !== 'number' || parameters.maxBytes <= 0) throw new Error('secret-scan requires a positive byte bound.')
      if (Buffer.byteLength(text) > parameters.maxBytes) return refusal('gate-denied', 'The outbound-content scan is incomplete.', definition.alternative)
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api_key|token|password)\s*[:=]\s*['"][^'"]+['"]/i.test(text)) return refusal('gate-denied', 'Credential-like content was detected; values are redacted.', definition.alternative)
    }
  }
  return null
}
