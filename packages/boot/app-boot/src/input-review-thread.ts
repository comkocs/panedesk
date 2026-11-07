/** A host timer supervises isolated input review, including synchronous filesystem calls. */
import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { en, zh } from './input-integrity-locales.ts'

/** Progress counts completed review units, not timer heartbeats. */
export interface InputReviewProgress {
  readonly completed: number
  readonly total: number
}

/** Reader-owned isolate; failed operations discard its cache before another request can start. */
export class InputReviewThread {
  private worker: ChildProcess | undefined
  private pending: ((error: Error) => void) | undefined
  private stopping: Promise<void> = Promise.resolve()
  private generation = 0

  /** Whether an imported reader remains available in this process. */
  get available(): boolean { return this.worker !== undefined && this.worker.connected }

  /** Terminate the owned isolate and await exit; subsequent use starts with a full import.
   * @returns Completion of child termination and the active request's rejection.
   */
  async dispose(): Promise<void> {
    this.generation++
    const worker = this.worker
    this.worker = undefined
    this.pending?.(new Error('Protected input review was disposed'))
    if (worker !== undefined && worker.exitCode === null && worker.signalCode === null) {
      // An idle resident isolate is unreferenced; its exit is dispatched only while it is referenced.
      worker.ref()
      worker.channel?.ref()
      this.stopping = new Promise<void>((resolve) => {
        worker.once('exit', () => { resolve() })
        worker.kill('SIGKILL')
      })
    }
    await this.stopping
  }

  /** Execute one isolated operation; callers serialize requests and validate the returned state.
   * @param request Structured-cloneable review input.
   * @param progress Completed-work sink; exceptions abort the operation.
   * @param answer Exact authenticated owner confirmation.
   * @param commit Host-owned final publication; omission forbids publication.
   * @param resident Retain the child and require request identifiers when true; false uses the startup protocol.
   * @param prepare Host-owned publication lock acquisition.
   * @returns The response for this request only.
   */
  async run(request: object, progress: (value: InputReviewProgress) => void,
    answer: (value: unknown) => Promise<boolean>, commit: ((value: unknown) => unknown) | undefined,
    resident: boolean, prepare?: (value: unknown) => void): Promise<unknown> {
    const generation = this.generation
    await this.stopping
    if (generation !== this.generation) throw new Error('Protected input review was disposed')
    if (this.pending !== undefined) throw new Error('Protected input review is already pending')
    if (this.worker === undefined) {
      const source = import.meta.url.endsWith('.ts')
      const entry = new URL(source ? './input-review-worker.ts' : './worker/input-review.js', import.meta.url)
      const worker = fork(fileURLToPath(entry), [], {
        execArgv: source ? ['--import', import.meta.resolve('tsx/esm')] : [],
        serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      })
      this.worker = worker
      const hostExit = (): void => { worker.kill('SIGKILL') }
      process.once('exit', hostExit)
      worker.on('error', () => { if (this.worker === worker) this.worker = undefined })
      worker.once('exit', () => {
        process.removeListener('exit', hostExit)
        if (this.worker === worker) this.worker = undefined
      })
      // Idle isolates must not keep a normally exiting host alive.
      worker.unref()
      worker.channel?.unref()
    }
    const worker = this.worker
    const requestId = randomUUID()
    worker.ref()
    worker.channel?.ref()
    return await new Promise((resolve, reject) => {
      let settled = false
      let timeoutMs = 30_000
      let completed = -1
      let confirmationPending = false
      let confirmation = 0
      let timer: ReturnType<typeof setTimeout>
      const settle = (error: unknown, result?: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending = undefined
        worker.removeListener('message', message)
        worker.removeListener('error', failed)
        worker.removeListener('exit', exited)
        const finish = (): void => {
          if (error !== undefined) reject(error instanceof Error ? error : new Error('Protected input review failed', { cause: error }))
          else resolve(result)
        }
        if (error === undefined && resident) {
          worker.unref()
          worker.channel?.unref()
          finish()
        } else {
          if (this.worker === worker) this.worker = undefined
          if (worker.pid === undefined || worker.exitCode !== null || worker.signalCode !== null) finish()
          else {
            // An idle resident isolate is unreferenced; its exit is dispatched only while it is referenced.
            worker.ref()
            worker.channel?.ref()
            this.stopping = new Promise<void>((done) => {
              worker.once('exit', () => { done(); finish() })
              worker.kill('SIGKILL')
            })
          }
        }
      }
      const failed = (error: Error): void => { settle(error) }
      const exited = (code: number | null): void => { settle(new Error(`Protected input worker exited without a result: ${String(code)}`)) }
      const arm = (): void => {
        clearTimeout(timer)
        timer = setTimeout(() => { settle(new Error(`${en.reviewStalled} / ${zh.reviewStalled}`)) }, timeoutMs)
      }
      const send = (value: object): void => {
        worker.send(resident ? { ...value, requestId } : value, (error) => { if (error) settle(error) })
      }
      const message = (value: unknown): void => {
        if (settled) return
        if (typeof value !== 'object' || value === null || !('kind' in value)
          || resident && (!('requestId' in value) || value.requestId !== requestId)) {
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
          if (confirmationPending || resident && (!('confirmation' in value) || value.confirmation !== confirmation + 1)) {
            settle(new Error('Invalid protected input confirmation sequence'))
            return
          }
          confirmation++
          confirmationPending = true
          clearTimeout(timer)
          void answer(value.change).then((accepted) => {
            confirmationPending = false
            if (!settled) { arm(); send({ kind: 'confirmation', accepted, confirmation }) }
          }, (error: unknown) => { settle(error) })
        } else if (value.kind === 'prepare' && 'state' in value) {
          try {
            if (prepare === undefined || confirmationPending) throw new Error('Protected input preparation has no host authorization')
            prepare(value.state)
            send({ kind: 'prepared' })
          } catch (error) { settle(error) }
        } else if (value.kind === 'commit' && 'state' in value) {
          try {
            if (commit === undefined || confirmationPending) throw new Error('Protected input commit has no host authorization')
            const revision = commit(value.state)
            send({ kind: 'commit', revision })
          } catch (error) {
            send({ kind: 'commit-refused', message: error instanceof Error ? error.message : 'Protected input commit refused' })
          }
        } else if (value.kind === 'result' && 'result' in value) settle(undefined, value.result)
        else if (value.kind === 'error' && 'message' in value && typeof value.message === 'string') settle(new Error(value.message))
        else settle(new Error('Invalid protected input worker response'))
      }
      this.pending = failed
      arm()
      worker.on('message', message)
      worker.once('error', failed)
      worker.once('exit', exited)
      send({ ...request, ...resident ? { resident: true } : {} })
    })
  }
}

/** Run an isolated review; one-shot calls await termination, resident calls retain reader-local state.
 * @param request Structured-cloneable review input.
 * @param progress User-visible progress sink; failures stop the review.
 * @param answer Authenticated owner confirmation for an exact candidate.
 * @param commit Host-owned final rename after generation validation; absent forbids commits.
 * @param thread Reader-owned isolate; omission creates a one-shot startup worker.
 * @param prepare Host-owned publication lock acquisition.
 * @returns Structured-cloned worker result, validated by the caller.
 */
export async function runInputReviewThread(
  request: object,
  progress: (value: InputReviewProgress) => void,
  answer: (value: unknown) => Promise<boolean>,
  commit?: (value: unknown) => unknown,
  thread?: InputReviewThread,
  prepare?: (value: unknown) => void,
): Promise<unknown> {
  return (thread ?? new InputReviewThread()).run(request, progress, answer, commit, thread !== undefined, prepare)
}
