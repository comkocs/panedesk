/** A host timer supervises isolated input review, including synchronous filesystem calls. */
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { en, zh } from './input-integrity-locales.ts'

/** Progress counts completed review units, not timer heartbeats. */
export interface InputReviewProgress {
  readonly completed: number
  readonly total: number
}

/** Run a host-owned review worker; every terminal outcome waits for worker termination.
 * @param request Structured-cloneable review input.
 * @param progress User-visible progress sink; failures stop the review.
 * @param answer Authenticated owner confirmation for an exact candidate.
 * @returns Structured-cloned worker result, validated by the caller.
 */
export async function runInputReviewThread(
  request: object,
  progress: (value: InputReviewProgress) => void,
  answer: (value: unknown) => Promise<boolean>,
): Promise<unknown> {
  const source = import.meta.url.endsWith('.ts')
  const entry = new URL(source ? './input-review-worker.ts' : './worker/input-review.js', import.meta.url)
  const worker = fork(fileURLToPath(entry), [], {
    execArgv: source ? ['--import', import.meta.resolve('tsx/esm')] : [],
    serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  return await new Promise((resolve, reject) => {
    let settled = false
    let timeoutMs = 30_000
    let completed = -1
    let timer: ReturnType<typeof setTimeout>
    const settle = (error: unknown, result?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const finish = (): void => {
        if (error !== undefined) reject(error instanceof Error ? error : new Error('Protected input review failed', { cause: error }))
        else resolve(result)
      }
      if (worker.exitCode !== null || worker.signalCode !== null) finish()
      else {
        worker.once('exit', finish)
        worker.kill('SIGKILL')
      }
    }
    const arm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => { settle(new Error(`${en.reviewStalled} / ${zh.reviewStalled}`)) }, timeoutMs)
    }
    arm()
    worker.on('message', (value: unknown) => {
      if (settled) return
      if (typeof value !== 'object' || value === null || !('kind' in value)) {
        settle(new Error('Invalid protected input worker response'))
        return
      }
      if (value.kind === 'configuration' && 'timeoutMs' in value && typeof value.timeoutMs === 'number'
        && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0) {
        timeoutMs = value.timeoutMs
        arm()
      } else if (value.kind === 'progress' && 'completed' in value && typeof value.completed === 'number'
        && Number.isSafeInteger(value.completed) && value.completed >= 0
        && 'total' in value && typeof value.total === 'number' && Number.isSafeInteger(value.total)
        && (value.total === -1 || value.total >= value.completed)) {
        if (value.completed <= completed) return
        completed = value.completed
        arm()
        try { progress({ completed, total: value.total }) } catch (error) { settle(error) }
      } else if (value.kind === 'confirmation' && 'change' in value) {
        clearTimeout(timer)
        void answer(value.change).then((accepted) => {
          if (!settled) {
            arm()
            worker.send({ kind: 'confirmation', accepted })
          }
        }, (error: unknown) => { settle(error) })
      } else if (value.kind === 'result' && 'result' in value) settle(undefined, value.result)
      else if (value.kind === 'error' && 'message' in value && typeof value.message === 'string') settle(new Error(value.message))
      else settle(new Error('Invalid protected input worker response'))
    })
    worker.once('error', (error) => { settle(error) })
    worker.once('exit', (code) => { settle(new Error(`Protected input worker exited without a result: ${String(code)}`)) })
    worker.send(request)
  })
}
