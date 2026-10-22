/** Controllable tool bodies registered and dispatched through the real tool runtime. */
import { defineContentToolFixture, type ToolDefinition } from '@panedesk/dsh-tools'
import { createTestGate } from './controls.ts'

/** One invocation of a long tool; concurrent invocations receive independent controls. */
export interface LongToolCall {
  /** The real invocation's cancellation signal. */
  readonly signal: AbortSignal
  /** Partial text retained for cancellation projection. */
  readonly partial: readonly string[]
  /** Resolves when the caller's cancellation is observed. */
  readonly abortObserved: Promise<void>
  /** Append partial text while the invocation is pending. */
  emit(text: string): void
  /** Complete normally; uncooperative calls remain pending until this is called. */
  finish(text: string): void
}

/** A registry-ready tool plus a FIFO of independently controllable invocations. */
export interface LongTool {
  /** Register with the production tool runtime. */
  readonly definition: ToolDefinition
  /** Await the next real body invocation, without polling. */
  nextCall(): Promise<LongToolCall>
  /** Release all pending bodies; callers must still drain the real tool pipeline. */
  dispose(): void
}

/**
 * Create a long tool without mocking dispatch, Session, or cancellation policy.
 * Partial text is projected into the final result, including cancellation.
 * @param name - model-visible tool name.
 * @param cooperative - whether cancellation releases the body automatically.
 * @returns a tool and invocation controls owned by the test.
 */
export function createLongTool(name: string, cooperative: boolean): LongTool {
  const queue: LongToolCall[] = []
  const consumers: Array<(call: LongToolCall) => void> = []
  const running = new Map<symbol, LongToolCall>()
  const partialByToken = new Map<symbol, readonly string[]>()
  const definition = defineContentToolFixture({
    name,
    description: 'Produce a controlled result.',
    parameters: {},
    async execute(_args, exec) {
      const gate = createTestGate()
      const aborted = Promise.withResolvers<void>()
      const partial: string[] = []
      let result = ''
      const call: LongToolCall = {
        signal: exec.signal,
        partial,
        abortObserved: aborted.promise,
        emit(text) { partial.push(text) },
        finish(text) { result = text; gate.release() },
      }
      partialByToken.set(exec.token, partial)
      running.set(exec.token, call)
      const stop = (): void => {
        aborted.resolve()
        if (cooperative) gate.release()
      }
      exec.signal.addEventListener('abort', stop, { once: true })
      if (exec.signal.aborted) stop()
      const consumer = consumers.shift()
      if (consumer === undefined) queue.push(call)
      else consumer(call)
      try {
        await gate.wait()
        return [{ type: 'text', text: [...partial, result].join('') }]
      } finally {
        exec.signal.removeEventListener('abort', stop)
        running.delete(exec.token)
      }
    },
    finalizeContent(exec, result) {
      const partial = partialByToken.get(exec.token)
      partialByToken.delete(exec.token)
      if (!result.isError || partial === undefined || partial.length === 0) return undefined
      return [{ type: 'text', text: partial.join('') }, ...result.content]
    },
  })
  return {
    definition,
    nextCall() {
      const call = queue.shift()
      return call === undefined ? new Promise((resolve) => { consumers.push(resolve) }) : Promise.resolve(call)
    },
    dispose() { for (const call of running.values()) call.finish('') },
  }
}
