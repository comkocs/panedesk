/** Durable admission prevents duplicate effects after lost replies or interrupted execution. */
import type { PrivateFiles } from './private-files.ts'
import { digest, object, parseJson } from './json.ts'

type Entry = { digest: string; state: 'pending' } | { digest: string; state: 'settled'; result: unknown }
/** A pending record never authorizes re-execution after a process loss. */
export type StoredOutcome = { state: 'missing' | 'pending' | 'conflict' } | { state: 'settled'; result: unknown }

/** One instance owns one private store; callers must not share it between running hosts. */
export class OperationStore {
  private entries: Record<string, Entry> = {}
  private serial: Promise<void> = Promise.resolve()
  private failed = false
  constructor(private readonly files: PrivateFiles, private readonly maxBytes: number, private readonly maxEntries: number) {}
  /** Load before opening ingress; corrupt or oversized data refuses activation.
   * @returns Completion after durable records have been validated.
   */
  async load(): Promise<void> {
    const text = await this.files.read('operations.json', this.maxBytes)
    if (text === null) return
    const data = parseJson(text, this.maxBytes)
    if (!object(data) || data.version !== 1 || !object(data.entries)) throw new Error('Operation store rejected')
    const entries: Record<string, Entry> = {}
    for (const [key, value] of Object.entries(data.entries)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !object(value) || typeof value.digest !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.digest) || !['pending', 'settled'].includes(String(value.state))) {
        throw new Error('Operation record rejected')
      }
      if (value.state === 'settled' && !Object.hasOwn(value, 'result')) throw new Error('Operation result missing')
      entries[key] = value as Entry
    }
    if (Object.keys(entries).length > this.maxEntries) throw new Error('Operation store capacity exceeded')
    this.entries = entries
  }
  /** Observe retained results without replaying a pending effect.
   * @param identity - Principal-scoped stable operation identity.
   * @returns Durable result or explicit missing/pending state.
   */
  query(identity: string, fingerprint?: string): StoredOutcome {
    if (this.failed) throw new Error('Operation store unavailable')
    const entry = this.entries[digest(identity)]
    if (entry !== undefined && fingerprint !== undefined && entry.digest !== fingerprint) return { state: 'conflict' }
    return entry === undefined ? { state: 'missing' } : entry.state === 'pending' ? { state: 'pending' }
      : { state: 'settled', result: entry.result }
  }
  /** Serialize admission and settlement; an exception leaves a durable pending record.
   * @param identity - Principal-scoped operation identity, excluding transport request IDs.
   * @param fingerprint - Stable operation parameters and authority digest.
   * @param execute - Called only after admission is durable.
   * @returns Original settled result, conflict, or pending unknown outcome.
   */
  run(identity: string, fingerprint: string, execute: () => Promise<unknown>): Promise<StoredOutcome> {
    const run = this.serial.then(async (): Promise<StoredOutcome> => {
      if (this.failed) throw new Error('Operation store unavailable')
      const key = digest(identity), previous = this.entries[key]
      if (previous !== undefined) {
        if (previous.digest !== fingerprint) return { state: 'conflict' }
        return previous.state === 'pending' ? { state: 'pending' } : { state: 'settled', result: previous.result }
      }
      if (Object.keys(this.entries).length >= this.maxEntries) throw new Error('Operation store capacity exceeded')
      this.entries[key] = { digest: fingerprint, state: 'pending' }
      await this.save()
      let result: unknown
      try { result = await execute() }
      catch (error) { void error; return { state: 'pending' } }
      const settled: Record<string, Entry> = { ...this.entries, [key]: { digest: fingerprint, state: 'settled', result } }
      await this.save(settled)
      this.entries = settled
      return { state: 'settled', result }
    })
    this.serial = run.then(() => {}, () => {})
    return run
  }
  /** Whether unresolved admissions require reconciliation before new writes. */
  get hasPending(): boolean { return Object.values(this.entries).some(entry => entry.state === 'pending') }
  /** Resolve a pending identity only from authenticated remote evidence, never by repeating an effect.
   * @param identity - Original principal-scoped identity.
   * @param fingerprint - Original request digest.
   * @param lookup - Read-only remote result query.
   * @returns Retained or remotely settled result; unknown remains pending.
   */
  reconcile(identity: string, fingerprint: string, lookup: () => Promise<StoredOutcome>): Promise<StoredOutcome> {
    const work = this.serial.then(async (): Promise<StoredOutcome> => {
      if (this.failed) throw new Error('Operation store unavailable')
      const key = digest(identity), previous = this.entries[key]
      if (previous === undefined) return { state: 'missing' }
      if (previous.digest !== fingerprint) return { state: 'conflict' }
      if (previous.state === 'settled') return { state: 'settled', result: previous.result }
      const remote = await lookup()
      if (remote.state !== 'settled') return { state: 'pending' }
      const settled: Record<string, Entry> = { ...this.entries, [key]: { digest: fingerprint, state: 'settled', result: remote.result } }
      await this.save(settled)
      this.entries = settled
      return remote
    })
    this.serial = work.then(() => {}, () => {})
    return work
  }
  /** Drain owned execution before releasing the store.
   * @returns Completion after all accepted operations settle or remain durably pending.
   */
  async close(): Promise<void> { await this.serial }
  private async save(entries = this.entries): Promise<void> {
    try {
      const text = JSON.stringify({ version: 1, entries })
      if (Buffer.byteLength(text) > this.maxBytes) throw new Error('Operation store exceeds limit')
      await this.files.write('operations.json', text)
    } catch (error) { this.failed = true; throw error }
  }
}
