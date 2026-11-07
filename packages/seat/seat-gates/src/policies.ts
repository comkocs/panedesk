/** Installed criterion implementations consume trusted executor facts, not executable JSON. */
import type { Context } from '@panedesk/cordis'
import type { GateCriterion, GateContext, GateDefinition, GateResult, SeatFailure } from '@panedesk/dsh-seat'
import type { Config } from './index.ts'
import { checkContinuation } from './continuation.ts'
import { checkPolling, type PollingState } from './polling.ts'

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
      const engine = ctx.get('seatEngine')
      if (!engine) throw new Error('Polling history is unavailable.')
      let pollingThreshold = config.pollingThreshold
      let maxSleepSeconds = config.maxSleepSeconds
      if (context.seat !== null) {
        const profile = await ctx.get('seats')?.resolve(context.seat)
        if (profile && !('status' in profile)) {
          pollingThreshold = Math.min(pollingThreshold, profile.pollingThreshold ?? pollingThreshold)
          maxSleepSeconds = Math.min(maxSleepSeconds, profile.maxSleepSeconds ?? maxSleepSeconds)
        }
      }
      let cursor: import('@panedesk/dsh-seat').EngineCursor | undefined
      let state: PollingState | undefined
      for (;;) {
        const page = await engine.query({ kinds: ['gate/hit'], limit: 1000, ...cursor === undefined ? {} : { cursor } })
        for (const effect of page.effects) {
          if (effect.kind !== 'gate/hit' || effect.data.definition.id !== definition.id || effect.data.definition.revision !== definition.revision) continue
          const previous = effect.data.context
          if (previous.hook === 'before-tool-call' && previous.sessionId === context.sessionId) state = checkPolling(previous, state, pollingThreshold, maxSleepSeconds).state
        }
        if (page.complete) break
        if (page.nextCursor === undefined || JSON.stringify(page.nextCursor) === JSON.stringify(cursor)) {
          throw new Error('Polling history is incomplete.')
        }
        cursor = page.nextCursor
      }
      failure = checkPolling(context, state, pollingThreshold, maxSleepSeconds).failure
    } else {
      failure = checkCustom(id, context, definition)
    }
    const facts = { gateId: definition.id, revision: definition.revision, hitCount: 0, expiresAt: definition.expiresAt, audit: 'recorded' as const }
    const tree = context.worktreeFacts
    if ((id === 'worktree-settle' && tree?.event === 'task-ended')
      || (id === 'worktree-mature' && tree?.event === 'mature' && tree.mature)) {
      return { ...facts, outcome: 'observe', reason: 'Registered worktrees require manual review.', alternative: tree.alternative }
    }
    if (id === 'memory' && context.hook === 'before-memory-write' && context.syntax === 'unknown') {
      return { ...facts, outcome: 'observe', reason: 'Write syntax is uncertain; turn audit is required.',
        alternative: 'Use seat_write with a registered memory directory.' }
    }
    if (!failure) return { ...facts, outcome: 'allow' }
    const result: GateResult = context.hook === 'after-subagent-return'
      ? { ...facts, outcome: 'observe', reason: failure.message, alternative: failure.alternative }
      : { ...facts, outcome: 'deny', reason: failure, alternative: failure.alternative }
    return result
  } }
}

/** Reject malformed built-in parameters before installing any consumers.
 * @param definitions - configured policy rows, never executable source.
 */
export function validateDefinitions(definitions: readonly GateDefinition[]): void {
  for (const definition of definitions) {
    const { type, parameters } = definition.criterion
    if (type === 'required-fields' && (!Array.isArray(parameters.required)
      || parameters.required.some(key => typeof key !== 'string'))) throw new Error('required-fields requires a string list.')
    if (type === 'report-first-line' && typeof parameters.prefix !== 'string') throw new Error('report-first-line requires a prefix.')
    if (type === 'secret-scan' && (typeof parameters.maxBytes !== 'number' || !Number.isSafeInteger(parameters.maxBytes)
      || parameters.maxBytes <= 0)) throw new Error('secret-scan requires a positive byte bound.')
  }
}

function refusal(code: SeatFailure['code'], message: string, alternative: string): SeatFailure {
  return { code, message, alternative, retryable: false, effectState: 'none' }
}

function checkCustom(id: string, context: GateContext, definition: GateDefinition): SeatFailure | null {
  const parameters = definition.criterion.parameters
  const tree = context.worktreeFacts
  if (id === 'worktree-client' && tree?.event === 'register' && tree.requestedKind === 'client'
    && tree.clientTreeCount >= tree.clientTreeLimit && !tree.authorizedForce) {
    return refusal('worktree-client-limit', 'The seat client-tree limit is reached.', tree.alternative)
  }
  if (id === 'seat-choice' && context.hook === 'before-open' && context.candidateSeats.length > 0
    && (context.seat === null || !context.candidateSeats.includes(context.seat))) {
    return refusal('seat-choice-required', 'Choose open-seat, traditional, or cancel.',
      `Candidates: ${context.candidateSeats.join(', ')}. Run panedesk --profile seat open --seat ${context.candidateSeats[0]}; `
      + 'traditional explicitly creates a free window; cancel creates nothing.')
  }
  if (id === 'explicit-batch' && context.hook === 'before-batch-open' && context.seats.length === 0) {
    return refusal('batch-explicit-seats-required', 'Batch opening requires explicit seats.', definition.alternative)
  }
  if (id === 'required-fields' && context.hook === 'before-subagent-dispatch') {
    const required = parameters.required
    if (!Array.isArray(required) || required.some(key => typeof key !== 'string')) throw new Error('required-fields requires a string list.')
    const missing = required.filter(key => typeof key === 'string' && (context.request[key] === undefined || context.request[key] === ''))
    if (missing.length) return refusal('gate-denied', `Missing dispatch fields: ${missing.join(', ')}.`, definition.alternative)
  }
  if (id === 'report-first-line' && context.hook === 'after-subagent-return') {
    if (typeof parameters.prefix !== 'string') throw new Error('report-first-line requires a prefix.')
    if (typeof context.result !== 'string' || !context.result.split('\n')[0]?.startsWith(parameters.prefix)) return refusal('gate-denied', 'The return report needs manual format review.', definition.alternative)
  }
  if (context.hook === 'before-tool-call') {
    const command = context.arguments.command
    if (id === 'pathspec' && typeof command === 'string' && /(?:^|[;&|]\s*)git\s+(?:add\s+(?:-A|--all|\.)|commit\s+(?:-a|--all))(?:\s|$)/.test(command)) return refusal('gate-denied', 'Use explicit paths for this Git mutation.', definition.alternative)
    if (id === 'secret-scan') {
      const text = JSON.stringify(context.arguments)
      if (typeof parameters.maxBytes !== 'number' || parameters.maxBytes <= 0) throw new Error('secret-scan requires a positive byte bound.')
      if (Buffer.byteLength(text) > parameters.maxBytes) return refusal('gate-denied', 'The outbound-content scan is incomplete.', definition.alternative)
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api_key|token|password)["']?\s*[:=]\s*['"][^'"]+['"]/i.test(text)) return refusal('gate-denied', 'Credential-like content was detected; values are redacted.', definition.alternative)
    }
  }
  return null
}
