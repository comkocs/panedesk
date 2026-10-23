/** Test-only Host composition substitutes only the unused browser transport capability. */
import { Service, type Context } from '@panedesk/cordis'
import type FileUploads from '@panedesk/dsh-client-file-upload'
import type {} from '@panedesk/dsh-shell'
import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@panedesk/dsh-llm'

/** File upload transport is absent; resolver ownership still follows controller lifecycle. */
export class UnusedFileUploads extends Service {
  constructor(ctx: Context) { super(ctx, 'fileUploads') }
  registerAgentResolver(_resolve: Parameters<FileUploads['registerAgentResolver']>[0]): () => void {
    return () => {}
  }
}

/** This composition never executes shell processes; only its declared confinement is consumed. */
export const UnusedShell = { name: 'unused-shell', apply(ctx: Context) {
  ctx.provide('shell', { sandboxMode: 'workspace-write',
    resolve() { throw new Error('Shell execution is not used by this composition') },
    run() { throw new Error('Shell execution is not used by this composition') },
    start() { throw new Error('Shell execution is not used by this composition') } })
} }

/** Deterministic external transport advertises the exact configured selection. */
export class CreationAdapter extends LlmAdapter {
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
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' }, responseModel: 'model-a', responseModelReported: 'same' }
  }
}
