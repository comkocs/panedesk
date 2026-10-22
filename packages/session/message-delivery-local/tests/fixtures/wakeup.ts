/** Event-driven substitute driver; durability and turn-start samples share a monotonic clock. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { vi } from 'vitest'
import type { MessageId, UserMessage } from '@panedesk/dsh-llm'
import type { EnqueueOptions } from '@panedesk/dsh-agent'
import { serviceFixture } from './persistence.ts'
import { FileMailbox } from '../../src/mailbox.ts'

/** Create an isolated Loader composition with an idle, event-driven target.
 * @param watch - enables filesystem watch; false exercises the fallback scanner.
 * @returns explicit publication and turn barriers with resource cleanup.
 */
export async function wakeupFixture(watch: boolean) {
  const home = await mkdtemp(join(process.env.MESSAGE_DELIVERY_TEST_HOME ?? tmpdir(), 'delivery-wakeup-'))
  const f = await serviceFixture(home, watch)
  const scheduler = await f.resume()
  const starts = new Map<MessageId, number>()
  const persisted = new Map<MessageId, number>()
  const waiting = new Map<MessageId, {
    resolve: (value: number) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  let wakes = 0
  let turn = 0
  const stop = f.ctx.on('session/event', (session, event) => {
    if (session !== f.session || event.type !== 'turn/start') return
    const at = performance.now()
    for (const message of scheduler.queue) {
      if (starts.has(message.id)) continue
      starts.set(message.id, at)
      const waiter = waiting.get(message.id)
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(at); waiting.delete(message.id) }
    }
  })
  const enqueue = scheduler.agent.enqueue
  scheduler.agent.enqueue = (message: UserMessage, options: EnqueueOptions) => {
    enqueue(message, options)
    if (!options.wakeup || options.passive) return
    wakes++
    f.session.append('turn/start', { turn: ++turn })
  }
  // The original method is invoked with its exact receiver below.
  // oxlint-disable-next-line typescript/unbound-method
  const append = FileMailbox.prototype.append
  const publication = vi.spyOn(FileMailbox.prototype, 'append').mockImplementation(async function (this: FileMailbox, ...args) {
    const record = await append.apply(this, args)
    const value = record.value
    if (value && typeof value === 'object' && 'kind' in value && value.kind === 'send'
      && 'message' in value && value.message && typeof value.message === 'object' && 'messageId' in value.message) {
      persisted.set(value.message.messageId as MessageId, performance.now())
    }
    return record
  })
  return { ...f, home, scheduler, persisted, starts, get wakes() { return wakes },
    async started(id: MessageId): Promise<number> {
      const at = starts.get(id)
      if (at !== undefined) return at
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error('Target turn/start unavailable within five seconds')) }, 5000)
        waiting.set(id, { resolve, reject, timer })
      })
    },
    async drain() {
      await f.ctx.serial('agent/input-preparing', { agent: scheduler.agent, turn: turn + 1, step: 1, signal: new AbortController().signal })
    },
    async dispose() {
      publication.mockRestore()
      stop()
      for (const waiter of waiting.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Driver disposed')) }
      await f.dispose()
      await rm(home, { recursive: true, force: true })
    },
  }
}
