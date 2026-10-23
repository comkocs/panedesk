/** Private engine segments commit whole decisions and retain interrupted tails unchanged. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, readFile, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { tryLockExclusive } from '@panedesk/node-addon-system/flock'
import { SEAT_ENGINE_NAMESPACE, SEAT_ENGINE_EVENT_NAMES, type EngineDecision, type EngineEffect, type EngineDecisionId, type SeatDigest, type SeatNodeId, type SeatErrorCode } from '@panedesk/dsh-seat'
import { EngineProjection } from './projection.ts'

/** Storage errors stop dispatch; ambiguous writes require reopening and replaying the journal. */
export class EngineError extends Error {
  constructor(readonly code: SeatErrorCode, message: string, options?: ErrorOptions) { super(message, options) }
}
/** Canonical JSON is independent of caller object insertion order.
 * @param value - JSON-serializable value.
 * @returns deterministic JSON bytes as text.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      throw new EngineError('invalid-request', 'Value is not JSON serializable')
    }
    const encoded = JSON.stringify(value)
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}
/** Digest canonical values without retaining raw source bytes.
 * @param value - serializable value.
 * @returns SHA-256 digest.
 */
export function digest(value: unknown): SeatDigest { return createHash('sha256').update(canonical(value)).digest('hex') as SeatDigest }
/** Frame checksums cover all semantic fields, excluding checksum and byte-length fields.
 * @param input - complete semantic decision.
 * @returns self-checking immutable frame.
 */
export function frame(input: Omit<EngineDecision, 'digest' | 'byteLength'>): EngineDecision {
  const text = canonical(input)
  return { ...input, digest: digest(input), byteLength: Buffer.byteLength(text) }
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
/** Decode one bounded complete line; malformed complete lines are never ignored.
 * @param text - complete JSON frame without its newline.
 * @param maxBytes - deployment byte limit including framing.
 * @returns checksum-verified frame.
 */
export function decodeFrame(text: string, maxBytes: number): EngineDecision {
  if (Buffer.byteLength(text) + 1 > maxBytes) throw new EngineError('engine-store-corrupt', 'Engine frame exceeds the configured bound')
  const parsed: unknown = JSON.parse(text)
  if (!record(parsed) || parsed.namespace !== SEAT_ENGINE_NAMESPACE || parsed.schemaVersion !== 1
    || typeof parsed.decisionId !== 'string' || typeof parsed.nodeId !== 'string'
    || !Number.isSafeInteger(parsed.sequence) || Number(parsed.sequence) < 1
    || !Number.isSafeInteger(parsed.policyRevision) || typeof parsed.observedAt !== 'string'
    || !Number.isFinite(Date.parse(parsed.observedAt)) || !Array.isArray(parsed.effects) || parsed.effects.length === 0
    || typeof parsed.digest !== 'string' || typeof parsed.byteLength !== 'number') throw new EngineError('engine-store-corrupt', 'Invalid engine frame header')
  for (const effect of parsed.effects) {
    if (!record(effect) || typeof effect.eventId !== 'string' || typeof effect.kind !== 'string'
      || !Object.hasOwn(SEAT_ENGINE_EVENT_NAMES, effect.kind) || !record(effect.data)) throw new EngineError('engine-store-corrupt', 'Invalid engine effect')
  }
  const { digest: checksum, byteLength, ...body } = parsed
  if (digest(body) !== checksum || Buffer.byteLength(canonical(body)) !== byteLength) throw new EngineError('engine-store-corrupt', 'Engine checksum mismatch')
  const verified: unknown = parsed
  return verified as EngineDecision
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try { await handle.sync() } finally { await handle.close() }
}
/** One node owner serializes local decisions and rejects other process owners. */
export class EngineJournal {
  projection = new EngineProjection()
  private owner: FileHandle | undefined
  private chain: Promise<void> = Promise.resolve()
  private failed = false
  private closing = false
  constructor(readonly root: string, readonly nodeId: SeatNodeId, readonly maxBytes: number) {}

  /** Acquire the stable native owner lock before recovery; contention never steals ownership. */
  async ready(): Promise<void> {
    if (this.owner) return
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const owner = await open(join(this.root, 'owner.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    try {
      await tryLockExclusive(owner.fd)
      const named = await stat(join(this.root, 'owner.lock')), held = await owner.stat()
      if (named.ino !== held.ino || named.dev !== held.dev) throw new EngineError('unavailable', 'Engine owner inode changed')
      await mkdir(join(this.root, 'events'), { mode: 0o700, recursive: true })
      await syncDirectory(this.root)
      const projection = new EngineProjection()
      for (const name of (await readdir(join(this.root, 'events'))).filter(name => name.endsWith('.jsonl')).sort()) {
        const text = await readFile(join(this.root, 'events', name), 'utf8')
        const lines = text.split('\n'); lines.pop()
        for (const line of lines) {
          const decision = decodeFrame(line, this.maxBytes)
          if (decision.nodeId !== this.nodeId) throw new EngineError('engine-store-corrupt', 'Engine node mismatch')
          projection.apply(decision)
        }
      }
      this.projection = projection
      this.owner = owner
    } catch (cause) { await owner.close(); throw new EngineError('engine-store-corrupt', 'Engine ownership or recovery is unavailable', { cause }) }
  }

  /** Serialize a synchronous decision builder; no business awaits hold the journal transaction.
   * @param build - evaluates latest committed state and returns all effects or no mutation.
   * @returns committed frame, or null when the decision has no effects.
   */
  async commit(build: (view: EngineProjection) => readonly EngineEffect[], policyRevision = 0): Promise<EngineDecision | null> {
    if (this.closing) throw new EngineError('unavailable', 'Engine journal is closing')
    const result = this.chain.then(async () => {
      if (!this.owner || this.failed) throw new EngineError('unavailable', 'Engine journal is not writable')
      const effects = build(this.projection)
      if (!effects.length) return null
      const decision = frame({ namespace: SEAT_ENGINE_NAMESPACE, schemaVersion: 1, decisionId: randomUUID() as EngineDecisionId,
        sequence: this.projection.sequence + 1, observedAt: new Date().toISOString(), nodeId: this.nodeId, policyRevision, effects })
      await this.append(decision)
      return decision
    })
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  private async append(decision: EngineDecision): Promise<void> {
    const text = `${canonical(decision)}\n`
    if (Buffer.byteLength(text) > this.maxBytes) throw new EngineError('source-payload-too-large', 'Complete engine decision exceeds its byte limit')
    const path = join(this.root, 'events', `${String(decision.sequence).padStart(16, '0')}-${randomUUID()}.jsonl`)
    try {
      const handle = await open(path, 'wx', 0o600)
      try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
      await syncDirectory(join(this.root, 'events'))
      this.projection.apply(decision)
    } catch (cause) { this.failed = true; throw new EngineError('unavailable', 'Engine commit outcome requires recovery', { cause }) }
  }

  /** Drain accepted transactions before releasing only this owner's descriptor. */
  async close(): Promise<void> { this.closing = true; await this.chain; await this.owner?.close(); this.owner = undefined }
}
