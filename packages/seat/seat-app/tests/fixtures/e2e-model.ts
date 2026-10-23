/** Deterministic external model transport; no credentials or network calls. */
import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@panedesk/dsh-llm'

export class SeatModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override providerInfo(provider: string) { return { id: provider, name: provider } }
  override listModels(provider: string) { return Promise.resolve([{ provider, id: 'model-a', name: 'model-a' }]) }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100000 },
      reasoning: { efforts: [{ id: ReasoningEffortId('effort-a'), name: 'effort-a' }], defaultEffort: ReasoningEffortId('effort-a') } })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Opening received.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Opening received.' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' }, responseModel: 'model-a', responseModelReported: 'same' }
  }
}
