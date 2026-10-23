/** Scripted external model delegates through real tools and waits using only their visible output. */
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@panedesk/dsh-llm'
import type { SessionId } from '@panedesk/dsh-session'
import { CreationAdapter } from './creation-provider.ts'

export class SubagentWaitModel extends CreationAdapter {
  parent?: SessionId
  childId?: string
  stage = 0
  entered = Promise.withResolvers<undefined>()
  release = Promise.withResolvers<undefined>()

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId !== this.parent) {
      this.entered.resolve(undefined)
      await this.release.promise
      yield* super.stream(options)
      return
    }
    if (this.stage >= 2) { yield* super.stream(options); return }
    this.requests.push(options)
    const stage = this.stage++
    if (stage === 1) {
      const childId = /started subagent ([^"\\\s]+)/.exec(JSON.stringify(options.messages))?.[1]
      if (!childId) throw new Error('The model did not receive a child session id')
      this.childId = childId
    }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`delegate-${stage}`),
      name: stage === 0 ? 'subagent' : 'seat_wait', arguments: JSON.stringify(stage === 0
        ? { description: 'Child task', prompt: 'Complete the child task.' }
        : { mode: 'all', objects: [{ kind: 'subagent', id: this.childId }] }) } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
