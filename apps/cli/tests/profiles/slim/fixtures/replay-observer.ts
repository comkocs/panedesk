/** Replay-only provider that records model inputs and verifies complete consumption. */
import type { Context } from '@panedesk/cordis'
import { installLlmReplay, type ReplayConfig } from '@panedesk/dsh-llm-replay'
import type { GenerateOptions, StreamChunk } from '@panedesk/dsh-llm'
import { writeFileSync } from 'node:fs'

export const name = 'slim-smoke-replay'
export const inject = ['llm']

/** Fixture paths and the isolated destination for model-input evidence. */
export interface Config extends ReplayConfig {
  /** JSON file receiving one entry per model call. */
  requestsFile: string
}

/**
 * Observe and replay model calls without changing the shipped profile's loop or tools.
 * @param ctx - Loader context owning the replay adapter and observer.
 * @param config - replay fixtures and the model-input evidence destination.
 */
export function apply(ctx: Context, config: Config): void {
  const requests: Array<Pick<GenerateOptions, 'provider' | 'model' | 'messages'>> = []
  ctx.on('llm/stream', (request, next) => (async function* (): AsyncIterable<StreamChunk> {
    requests.push({ provider: request.provider, model: request.model, messages: request.messages })
    writeFileSync(config.requestsFile, JSON.stringify({ path: 'llm/stream', requests }))
    yield* next()
    if (requests.length === 2) handle.assertConsumed()
  })())
  const handle = installLlmReplay(ctx, config)
  ctx.effect(() => () => { handle.dispose() })
}
