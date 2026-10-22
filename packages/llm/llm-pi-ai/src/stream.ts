/**
 * pi-ai assistant event translation into the Harness streaming protocol.
 *
 * pi-ai tool-call arguments are parsed objects while the Harness keeps their
 * raw JSON representation. pi-ai also reports failures as terminal stream
 * events, which this module maps into Harness finish chunks.
 *
 * @module dsh-llm-pi-ai/stream
 */

import { brandString } from '@panedesk/dsh-brand'
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE } from '@panedesk/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@panedesk/dsh-llm'
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow'
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'
import { toPiReplayState } from './replay.ts'

type FinishChunk = Extract<StreamChunk, { type: 'finish' }>

/** Per-request wire observations; SDK-initialized model names are never response evidence. */
export class PiResponseEvidence {
  private observed = false
  private responseModel: string | undefined
  private longWrites: number | undefined
  private translatedUsage: TokenUsage | undefined
  private readonly reportedUsage: Record<string, number> = {}
  /** HTTP status observed by the SDK response hook, absent before any response. */
  status: number | undefined

  /**
   * @param requestedModel - request identity used only to compare an observed name.
   * @param api - resolved wire protocol; unsupported protocols remain unobservable.
   */
  constructor(private readonly requestedModel: string, private readonly api: string) {}

  /**
   * Observe a provider event without modifying the SDK's parser input.
   * @param raw - untrusted provider stream event from the public SDK hook.
   */
  observe(raw: unknown): void {
    const event = wireObject(raw)
    if (event === undefined) return
    let envelope: Record<string, unknown> | undefined
    if (this.api === 'anthropic-messages') {
      if (event.type === 'message_start') envelope = wireObject(event.message)
      if (event.type === 'message_start' || event.type === 'message_delta') {
        const usage = wireObject(envelope?.usage ?? event.usage)
        const creation = wireObject(usage?.cache_creation)
        const long = creation?.ephemeral_1h_input_tokens
        if (typeof long === 'number' && Number.isSafeInteger(long) && long >= 0) this.longWrites = long
      }
    } else if (this.api === 'openai-responses') {
      envelope = wireObject(event.response)
    } else if (this.api === 'openai-completions') {
      envelope = event
    } else return
    const usage = wireObject(envelope?.usage ?? event.usage)
    if (usage !== undefined) {
      for (const [key, value] of Object.entries(usage)) {
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) this.reportedUsage[key] = value
        const detail = wireObject(value)
        if (detail !== undefined) for (const [name, count] of Object.entries(detail)) {
          if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) this.reportedUsage[`${key}.${name}`] = count
        }
      }
    }
    this.observed = true
    if (typeof envelope?.model === 'string' && envelope.model.length > 0) this.responseModel = envelope.model
  }

  /**
   * Add observed evidence to translated chunks without changing their outcome or replay state.
   * @param chunk - SDK-translated stream chunk.
   * @param metadata - resolved route and effective wire-cache evidence.
   * @returns the chunk with observed usage tiers or terminal metadata.
   */
  enrich(chunk: StreamChunk, metadata: Omit<Partial<FinishChunk>, 'type' | 'reason' | 'replayState'>): StreamChunk {
    if (chunk.type === 'usage') {
      this.translatedUsage = chunk.usage
      const long = this.api === 'anthropic-messages' ? this.longWrites
        : metadata.cacheWriteTiering?.kind === 'tiered' && chunk.usage.cacheWriteTokens !== undefined
          ? metadata.cacheRetention === '12h' ? chunk.usage.cacheWriteTokens
            : metadata.cacheRetention === '30m' ? 0 : undefined
          : undefined
      return long === undefined ? chunk : { ...chunk, usage: { ...chunk.usage, cacheWriteLongTokens: long } }
    }
    if (chunk.type !== 'finish') return chunk
    const reason = chunk.reason
    const finish: FinishChunk = {
      ...chunk, ...metadata,
      ...this.responseModel === undefined ? {} : { responseModel: this.responseModel },
      responseModelReported: this.responseModel !== undefined
        ? this.responseModel === this.requestedModel ? 'same' : 'different'
        : this.observed ? 'missing' : 'unobservable',
      ...this.status === undefined ? {} : { httpStatus: this.status },
      reason: this.status !== undefined && this.status >= 400 && (reason.kind === 'error' || reason.kind === 'aborted')
        ? { ...reason, failure: { ...reason.failure, status: this.status } } : reason,
    }
    const raw = this.reportedUsage
    const observed = Object.keys(raw).length > 0
    const usage = observed && this.translatedUsage !== undefined ? { ...this.translatedUsage } : undefined
    if (usage !== undefined) {
      const read = raw.cache_read_input_tokens ?? raw['input_tokens_details.cached_tokens']
        ?? raw['prompt_tokens_details.cached_tokens'] ?? raw.prompt_cache_hit_tokens
      const write = raw.cache_creation_input_tokens ?? raw['input_tokens_details.cache_write_tokens']
        ?? raw['prompt_tokens_details.cache_write_tokens'] ?? raw.cache_write_tokens
      if (read !== undefined) usage.cacheReadTokens = read
      if (write !== undefined) usage.cacheWriteTokens = write
      const long = this.api === 'anthropic-messages' ? this.longWrites
        : write !== undefined && metadata.cacheWriteTiering?.kind === 'tiered'
          ? metadata.cacheRetention === '12h' ? write : metadata.cacheRetention === '30m' ? 0 : undefined
          : undefined
      if (long !== undefined) usage.cacheWriteLongTokens = long
      const prompt = raw.prompt_tokens
      const completion = raw.completion_tokens
      const reasoning = raw['completion_tokens_details.reasoning_tokens'] ?? raw.reasoning_tokens
      if (prompt !== undefined && completion !== undefined && reasoning !== undefined
        && prompt + completion + reasoning === raw.total_tokens) {
        usage.outputTokens = completion + reasoning
        usage.totalTokens = raw.total_tokens
      }
    }
    LlmAdapter.ledgerEvidence?.set(finish, {
      ...usage === undefined ? {} : { usage },
      ...observed ? { reportedUsage: { ...raw } } : {},
      ...['anthropic-messages', 'openai-responses', 'openai-completions'].includes(this.api) ? { usageObserved: observed } : {},
    })
    return finish
  }
}

function wireObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/**
 * Map pi-ai usage (reasoning folded into output by pi-ai). Anthropic input_tokens
 * already excludes cache reads/writes. OpenAI prompt_tokens/input_tokens includes
 * both; pi-ai subtracts cached_tokens and cache_write_tokens before setting input.
 * Cache writes remain totals; the provider hook adds only an observed long subset.
 * @param usage - cumulative usage from the terminal pi-ai event.
 * @returns harness counts with pi-ai's exact total; cache fields appear only
 *   when non-zero (pi-ai reports zeros, not absence).
 */
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

// XXX(pi-ai upstream): pi-ai flattens the caught error to `error.message`
// (api/anthropic-messages.js: `errorMessage = error instanceof Error ?
// error.message : JSON.stringify(error)`), discarding the original Error and its
// `cause` chain before it reaches us. undici carries the actionable transport
// detail on `cause` (e.g. `SocketError: other side closed`) but hands the fetch
// wrapper a bare `terminated`, so we are left pattern-matching terse words here.
// If pi-ai ever forwards the original Error (or a fetch/dispatcher hook that lets
// us capture the cause ourselves), classify on `code`/`cause` instead of text.
function classifyPiAiError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  // A rejected request body (gateway or provider size cap): resending the
  // same request cannot succeed, so it is invalid, not transient.
  if (/\b413\b|failed to buffer the request body:\s*length limit exceeded|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  // A stream truncated before the provider's terminal event: each pi-ai provider
  // throws its own wording when the wire closes mid-response without a terminal
  // event (`… stream ended before message_stop`, `… before a terminal response
  // event`, `… ended without a terminal event`, `Stream ended without
  // finish_reason`). The connection dropped mid-response, so this is a transport
  // truncation, not a model-level error.
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    // undici renders a mid-stream socket drop as a bare `terminated` (its
    // `cause` — the real SocketError — was flattened away upstream); Node's
    // stream layer says `Premature close`.
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'PI_AI_ERROR'
}

/**
 * Map a terminal pi-ai event to the harness finish reason.
 * @param message - the assistant message carried by the `done` or `error` event.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @returns the mapped harness reason. Recognized error text, `stop` usage above
 *   `contextWindow`, and zero-output `length` usage that fills the window map
 *   to `CONTEXT_WINDOW_EXCEEDED`; a `stop` with no content blocks maps to an
 *   `EMPTY_RESPONSE` error, while terminal `pending` and `deferred` states map
 *   to non-retryable `PI_AI_ERROR` failures.
 */
export function mapStopReason(message: AssistantMessage, contextWindow?: number): FinishReason {
  const piAiOverflow = isContextOverflow(message, contextWindow)
  const harnessOverflow = message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)
  if (piAiOverflow || harnessOverflow) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }

  switch (message.stopReason) {
    case 'stop':
      // A terminal stop that produced no content blocks is a degenerate
      // provider completion, not a successful (empty) assistant message.
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'pending': return {
      kind: 'error',
      failure: { message: `pi-ai stream for model "${message.model}" ended pending`, code: 'PI_AI_ERROR' },
    }
    case 'deferred': return {
      kind: 'error',
      failure: { message: `pi-ai deferred response for model "${message.model}" is not supported`, code: 'PI_AI_ERROR' },
    }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' },
    }
    case 'error': {
      const text = message.errorMessage ?? 'pi-ai stream error'
      return { kind: 'error', failure: { message: text, code: classifyPiAiError(text) } }
    }
  }
}

/**
 * Translate the pi-ai event stream into StreamChunks. pi-ai never throws
 * mid-stream — failures arrive as `error` events, which become error/aborted
 * `finish` chunks (the harness protocol's other error-delivery style).
 * @param events - one assistant turn's pi-ai event stream.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @param callerSignal - caller cancellation state; an aborted caller makes any
 *   in-band terminal error an aborted finish.
 * @param requestedModel - request model identity recorded for durable replay.
 * @returns the harness chunks, ending with `usage` then `finish`; throws
 *   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
  callerSignal?: AbortSignal,
  requestedModel?: string,
): AsyncGenerator<StreamChunk> {
  // pi-ai contentIndex ↔ our block index map 1:1 (both count blocks from 0
  // in stream order), but we track ids per index for tool calls.
  const toolIds = new Map<number, { id: string; name: string }>()

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        // The id/name live on the partial's content at this index.
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: brandString<ToolCallId>(known?.id ?? ''),
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: brandString<ToolCallId>(event.toolCall.id),
            name: event.toolCall.name,
            // pi-ai hands back the PARSED arguments; the harness vocabulary
            // keeps the raw string.
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(event.message, contextWindow),
          replayState: toPiReplayState(event.message, requestedModel),
        }
        return
      case 'error':
        // In-stream error delivery (pi-ai's style) → error finish chunk
        // (the harness's other sanctioned error path besides throwing).
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(
            callerSignal?.aborted ? { ...event.error, stopReason: 'aborted' } : event.error,
            contextWindow,
          ),
        }
        return
      // no default: AssistantMessageEvent is pi-ai's closed union; a new
      // event type should fail compilation here via tsc's exhaustiveness
      // when one is added (switch covers all current variants).
    }
  }
  throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}
