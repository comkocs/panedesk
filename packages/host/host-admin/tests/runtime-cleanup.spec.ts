/** Failed cleanup cannot strand locks; signal and normal shutdown share one owner. */
import { expect, it, vi } from 'vitest'
import { drainRuntime, onRuntimeTermination } from '../src/runtime-cleanup.ts'

it('drains every resource and releases the lock before reporting earlier cleanup failures', async () => {
  const calls: string[] = []
  await expect(drainRuntime([
    async () => { calls.push('listener'); throw new Error('listener close failed') },
    async () => { calls.push('store'); throw new Error('store close failed') },
    async () => { calls.push('credential') },
    async () => { calls.push('lock') },
  ])).rejects.toThrow('Runtime cleanup failed')
  expect(calls).toEqual(['listener', 'store', 'credential', 'lock'])
})

it.each(['SIGINT', 'SIGTERM'] as const)('routes %s to cleanup and removes both listeners on disposal', async (signal) => {
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]
  const dispose = vi.fn(async () => {})
  const failed = vi.fn()
  const remove = onRuntimeTermination(dispose, failed)
  try {
    const handler = process.listeners(signal).at(-1)
    if (!handler) throw new Error('Termination listener missing')
    handler(signal)
    await vi.waitFor(() => { expect(dispose).toHaveBeenCalledTimes(1) })
    expect(failed).not.toHaveBeenCalled()
  } finally { remove() }
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before)
})
