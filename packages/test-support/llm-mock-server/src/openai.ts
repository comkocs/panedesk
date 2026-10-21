/** OpenAI streaming events mapped from the shared mock behavior and evidence options. */
import type { MockLlmRequestRecord, MockLlmServerOptions } from './index.ts'

interface OpenAIOptions {
  readonly usage: NonNullable<MockLlmServerOptions['usage']>
  readonly responseModel: string | null
  readonly successText: string
  readonly partialText: string
  readonly reasoningText: string
  readonly chunkSize: number
  readonly toolName: string
  readonly toolArguments: string
}

interface ResponseItem {
  type: string
  id: string
  [field: string]: unknown
}

/**
 * Build protocol events, or return null for faults handled by the shared transport.
 * @param options - Resolved content and usage options.
 * @param record - Selected behavior and OpenAI route.
 * @returns Ordered SSE payloads; Chat payloads are JSON strings without named events.
 */
export function openAIEvents(
  options: OpenAIOptions,
  record: MockLlmRequestRecord,
): Array<string | { type: string; [field: string]: unknown }> | null {
  const { behavior } = record
  switch (behavior) {
    case 'empty': case 'stream_eof': case 'partial_eof': case 'partial_disconnect':
    case 'malformed_json': case 'malformed_event': case 'wrong_content_type':
    case 'success': case 'reasoning_success': case 'tool_call_success': case 'max_tokens': case 'slow_success':
      break
    default:
      return null
  }
  if (behavior === 'malformed_json') return ['{not-json']
  if (behavior === 'malformed_event') {
    return record.protocol === 'responses'
      ? [{ type: 'response.output_item.added', output_index: 0, item: null }]
      : [JSON.stringify({ choices: [{ delta: { content: 1 } }] })]
  }

  const partial = behavior === 'partial_eof' || behavior === 'partial_disconnect'
  const empty = behavior === 'empty' || behavior === 'stream_eof'
  const tool = behavior === 'tool_call_success'
  const text = empty || tool ? '' : partial ? options.partialText : options.successText
  const outputTokens = options.usage.output_tokens ?? (tool ? 2 : Array.from(text).length)
  const inputTokens = options.usage.input_tokens ?? 3
  const details = {
    ...options.usage.cache_read_input_tokens === undefined ? {} : { cached_tokens: options.usage.cache_read_input_tokens },
    ...options.usage.cache_creation_input_tokens === undefined ? {} : { cache_write_tokens: options.usage.cache_creation_input_tokens },
  }
  const model = options.responseModel === null ? {} : { model: options.responseModel }
  const split = (value: string): string[] => {
    const points = Array.from(value)
    const chunks: string[] = []
    for (let index = 0; index < points.length; index += options.chunkSize) chunks.push(points.slice(index, index + options.chunkSize).join(''))
    return chunks
  }

  if (record.protocol === 'chat_completions') {
    const events: string[] = []
    const chunk = (choices: object[], usage?: object): void => {
      events.push(JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 0, ...model, choices, ...usage === undefined ? {} : { usage } }))
    }
    const delta = (value: object): void => { chunk([{ index: 0, delta: value, finish_reason: null }]) }
    delta({ role: 'assistant', content: '' })
    if (behavior === 'stream_eof') return events
    if (behavior === 'reasoning_success') {
      for (const part of split(options.reasoningText)) delta({ reasoning_content: part })
    }
    if (tool) {
      delta({ tool_calls: [{ index: 0, id: 'mock-call-1', type: 'function', function: { name: options.toolName, arguments: '' } }] })
      for (const part of split(options.toolArguments)) delta({ tool_calls: [{ index: 0, function: { arguments: part } }] })
    } else {
      for (const part of split(text)) delta({ content: part })
    }
    if (partial) return events
    chunk([{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : behavior === 'max_tokens' ? 'length' : 'stop' }])
    chunk([], {
      prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens,
      ...Object.keys(details).length === 0 ? {} : { prompt_tokens_details: details },
    })
    events.push('[DONE]')
    return events
  }

  const events: Array<{ type: string; [field: string]: unknown }> = []
  const event = (type: string, fields: object): void => { events.push({ type, sequence_number: events.length, ...fields }) }
  const response = { id: 'mock-response', object: 'response', created_at: 0, ...model }
  event('response.created', { response: { ...response, status: 'in_progress', output: [] } })
  if (behavior === 'stream_eof') return events
  const output: ResponseItem[] = []
  const item = (value: ResponseItem, valueText: string, deltaType: string): void => {
    const outputIndex = output.length
    output.push(value)
    const initial = value.type === 'function_call' ? { ...value, arguments: '', status: 'in_progress' }
      : value.type === 'message' ? { ...value, content: [], status: 'in_progress' } : { ...value, summary: [] }
    event('response.output_item.added', { output_index: outputIndex, item: initial })
    for (const part of split(valueText)) {
      event(deltaType, { output_index: outputIndex, item_id: value.id, content_index: 0, summary_index: 0, delta: part })
    }
    if (!partial) {
      event('response.output_item.done', { output_index: outputIndex, item: value })
    }
  }
  if (behavior === 'reasoning_success') {
    item({ type: 'reasoning', id: 'mock-reasoning', summary: [{ type: 'summary_text', text: options.reasoningText }] }, options.reasoningText, 'response.reasoning_summary_text.delta')
  }
  if (tool) {
    item({ type: 'function_call', id: 'mock-function', call_id: 'mock-call-1', name: options.toolName, arguments: options.toolArguments, status: 'completed' }, options.toolArguments, 'response.function_call_arguments.delta')
  } else if (!empty) {
    item({ type: 'message', id: 'mock-message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }, text, 'response.output_text.delta')
  }
  if (partial) return events
  const incomplete = behavior === 'max_tokens'
  event(incomplete ? 'response.incomplete' : 'response.completed', {
    response: {
      ...response, status: incomplete ? 'incomplete' : 'completed', output,
      ...incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {},
      usage: {
        input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens,
        ...Object.keys(details).length === 0 ? {} : { input_tokens_details: details },
      },
    },
  })
  return events
}
