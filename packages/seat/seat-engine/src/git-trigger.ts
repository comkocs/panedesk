/** Read-only registered-ref observation retains its checkpoint until ingress is durable. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AcceptTriggerResult, SeatTriggerEvidence, EngineGitCheckpoint } from '@panedesk/dsh-seat'
import { EngineError, type EngineJournal } from './journal.ts'
import { fact } from './triggers.ts'

const execute = promisify(execFile)
type GitEvidence = Extract<SeatTriggerEvidence, { kind: 'git' }>
type Checkpoint = { schemaVersion: 1; repositoryId: string; ref: string; objectId: string | null; sequence: number }
/** Registered repository and ref; no hooks, fetches or repository writes are performed. */
export interface GitTriggerOptions {
  repository: string
  repositoryId: GitEvidence['repositoryId']
  ref: string
  /** Legacy checkpoint is read only when no journal position exists. */
  checkpoint: string
  /** The engine journal owns baseline migration and accepted positions. */
  journal: EngineJournal
  fallbackMs: number
  accept(evidence: GitEvidence): Promise<AcceptTriggerResult>
  onError(error: unknown): void
}
/** File notifications and a bounded fallback share one serial observation controller. */
export class GitTrigger {
  private running: Promise<void> | undefined
  private readonly watchers: FSWatcher[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  constructor(private readonly options: GitTriggerOptions) {}
  /** Establish a non-triggering baseline, then attach read-only notifications. */
  async start(): Promise<void> {
    if (!this.options.ref.startsWith('refs/') || !Number.isSafeInteger(this.options.fallbackMs) || this.options.fallbackMs < 1) throw new EngineError('invalid-request',
      'Invalid registered ref or fallback interval')
    await execute('git', ['check-ref-format', this.options.ref], { cwd: this.options.repository })
    await this.scan()
    const { stdout } = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: this.options.repository })
    const common = stdout.trim()
    const notify = () => { void this.scan().catch((error: unknown) => { this.options.onError(error) }) }
    for (const path of [common, join(common, 'refs')]) {
      const watcher = watch(path, { recursive: true }, notify)
      watcher.on('error', (error) =>{  this.options.onError(error) })
      this.watchers.push(watcher)
    }
    this.timer = setInterval(notify, this.options.fallbackMs)
    this.timer.unref()
  }
  /** Coalesce concurrent notices; object identity is always reread from git.
   * @returns after durable ingress and checkpoint publication.
   */
  scan(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.running ??= this.observe().finally(() => { this.running = undefined })
    return this.running
  }
  private async observe(): Promise<void> {
    const key = JSON.stringify([this.options.repositoryId, this.options.ref])
    let previous: EngineGitCheckpoint | undefined = this.options.journal.projection.git.get(key)
    if (!previous) try {
      const value: unknown = JSON.parse(await readFile(this.options.checkpoint, 'utf8'))
      if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1
        || !('repositoryId' in value) || value.repositoryId !== this.options.repositoryId
        || !('ref' in value) || value.ref !== this.options.ref || !('sequence' in value) || !Number.isSafeInteger(value.sequence)
        || Number(value.sequence) < 0 || Number(value.sequence) >= Number.MAX_SAFE_INTEGER
        || !('objectId' in value) || (value.objectId !== null && (typeof value.objectId !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.objectId)))) {
        throw new EngineError('engine-store-corrupt', 'Invalid git observation checkpoint')
      }
      previous = value as Checkpoint
      const migrated = previous
      await this.options.journal.commit(() => [fact({ kind: 'git/checkpoint', data: migrated })])
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const { stdout } = await execute('git', ['for-each-ref', '--format=%(refname) %(objectname)',
      this.options.ref], { cwd: this.options.repository })
    const line = stdout.split('\n').find(line => line.startsWith(`${this.options.ref} `))
    const objectId = line?.slice(this.options.ref.length + 1) ?? null
    if (previous?.objectId === objectId) return
    const sequence = previous ? previous.sequence + 1 : 0
    if (previous) {
      const result = await this.options.accept({ kind: 'git', repositoryId: this.options.repositoryId, ref: this.options.ref,
        oldObjectId: previous.objectId, newObjectId: objectId, observationSequence: sequence })
      if (result.status === 'rejected' && result.error.code !== 'disabled') throw new EngineError('unavailable',
        'Git ingress was not durably accepted')
    }
    if (!previous) await this.options.journal.commit(() => [fact({ kind: 'git/checkpoint', data: {
      repositoryId: this.options.repositoryId, ref: this.options.ref, objectId, sequence,
    } })])
    const committed = this.options.journal.projection.git.get(key)
    if (committed?.objectId !== objectId || committed.sequence !== sequence) throw new EngineError('unavailable',
      'Git ingress did not commit its checkpoint')
  }
  /** Stop new observations and drain the one owned scan. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    for (const watcher of this.watchers) watcher.close()
    await this.running
  }
}
