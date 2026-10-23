import { performance } from 'node:perf_hooks'
import { vi } from 'vitest'

export function clock() {
  vi.useFakeTimers({ toFake: ['Date'] })
  return {
    advance(milliseconds: number) { vi.setSystemTime(Date.now() + milliseconds) },
    close() { vi.useRealTimers() },
  }
}

export async function measured<T>(name: string, action: () => Promise<T>) {
  const start = performance.now()
  const value = await action()
  const milliseconds = performance.now() - start
  console.log(JSON.stringify({ name, milliseconds }))
  return { value, milliseconds }
}
