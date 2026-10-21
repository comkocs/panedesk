/** Append-only, checksummed JSONL segments with native-lock serialization and durable acknowledgements. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative as relativePath } from 'node:path'
import { canonicalJson, digest, rebuildIndex, slotContent, uniqueSlot } from './index-store.ts'
import { withWriterLock, type WriterLockOptions } from './lock.ts'
import type { LedgerAppendResult, LedgerArtifactAppend, LedgerArtifactAppendResult, LedgerArtifactFinishResult, LedgerArtifactReference, LedgerEvent, LedgerNodeId, LedgerWatermark } from './types.ts'

/** Explicit local storage limits shared by every writer and scanner. */
export interface JournalOptions extends WriterLockOptions {
  maxRecordBytes: number
}

/** Validated scan results expose uncommitted tails and corruption without discarding bytes. */
export interface LedgerScan {
  events: LedgerEvent[]
  complete: boolean
  tails: string[]
  corrupt: string[]
  watermark: LedgerWatermark
}

/** Synchronize a directory after creating a durable child name.
 * @param path - Existing directory owned by the ledger.
 */
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** Create restricted directories and synchronize each newly visible parent entry.
 * @param path - Ledger-owned absolute directory.
 */
export async function ensureDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }) } catch (error) {
    if (isCode(error, 'EEXIST')) {
      const entry = await lstat(path)
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Ledger directory must not be a symbolic link')
      await syncDirectory(dirname(path))
      return
    }
    if (!isCode(error, 'ENOENT')) throw error
    await ensureDirectory(dirname(path))
    await ensureDirectory(path)
    return
  }
  await syncDirectory(dirname(path))
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function files(path: string): Promise<string[]> {
  let entries
  try { entries = await readdir(path, { withFileTypes: true }) } catch (error) {
    if (isCode(error, 'ENOENT')) return []
    throw error
  }
  const paths: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('Ledger scan refuses symbolic links')
    if (entry.isDirectory()) paths.push(...await files(join(path, entry.name)))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.push(join(path, entry.name))
  }
  return paths
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ledger object')
  return value as Record<string, unknown>
}

function strings(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) if (typeof value[key] !== 'string' || !value[key]) throw new Error('Invalid ledger string field')
}

function numbers(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) {
    throw new Error('Invalid ledger numeric field')
  }
}

function stringArray(value: unknown): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Invalid ledger string array')
}

function assertEvent(value: unknown): asserts value is LedgerEvent {
  const event = record(value)
  if (event.schemaVersion !== 1 || !Number.isFinite(event.observedAt)) throw new Error('Invalid ledger version or timestamp')
  for (const key of ['eventId', 'nodeId', 'runId', 'sessionId', 'kind']) {
    if (typeof event[key] !== 'string' || !event[key]) throw new Error('Missing ledger identity')
  }
  const kinds = ['call/start', 'call/end', 'run/start', 'run/end', 'wait/start', 'wait/end', 'cache/break', 'cache/evidence', 'retry', 'compaction', 'alert', 'delivery', 'process/observed', 'policy/denied']
  if (!kinds.includes(String(event.kind))) throw new Error('Unknown ledger event kind')
  if (String(event.kind).startsWith('call/') || String(event.kind).startsWith('run/')) {
    const data = record(event.data)
    if (String(event.kind).startsWith('call/') && (typeof data.callId !== 'string' || data.callId !== event.callId)) throw new Error('Mismatched ledger call identity')
    if (String(event.kind).startsWith('run/') && data.runId !== event.runId) throw new Error('Mismatched ledger run identity')
    if (String(event.kind).endsWith('/start')) {
      strings(data, ['seat', 'window', 'rootSessionId', 'accountLabel', 'identitySource'])
      if (event.kind === 'call/start') {
        strings(data, ['logicalRequestId', 'provider', 'modelFamily', 'requestedModel', 'purpose', 'priceVersion', 'priceKey'])
        numbers(data, ['attemptIndex', 'startedAt'])
        stringArray(record(data.cache).breakReasons)
        record(data.cacheWriteTiering)
      } else {
        stringArray(data.deliveryPaths)
        if (!['pending', 'started'].includes(String(data.launchState))) throw new Error('Invalid ledger launch state')
      }
      if (data.sessionId !== event.sessionId || data.nodeId !== event.nodeId || data.runId !== event.runId || !Number.isFinite(data.startedAt)) throw new Error('Mismatched ledger start identity')
    } else if (!['completed', 'timeout', 'killed', 'error', 'cancelled'].includes(String(data.endReason))) throw new Error('Invalid ledger terminal reason')
    if (String(event.kind).endsWith('/end')) {
      numbers(data, ['observedAt'])
      if (typeof data.recovered !== 'boolean') throw new Error('Invalid ledger recovery evidence')
      if (event.kind === 'call/end') {
        numbers(data, ['endedAt', 'wallMs', 'modelInFlightMs', 'queueMs', 'backoffMs', 'compactionCount'])
        strings(data, ['effectiveModel', 'responseModelReported', 'usageState', 'pricingState'])
        if (!Array.isArray(data.waits) || !Array.isArray(data.compactionTimes)) throw new Error('Invalid ledger timing evidence')
      } else strings(data, ['deliveryState'])
    }
  } else if (String(event.kind).startsWith('wait/')) {
    const interval = record(event.interval)
    numbers(interval, ['startedAt'])
    strings(interval, ['kind'])
  } else if (String(event.kind).startsWith('cache/')) {
    const evidence = record(event.evidence)
    stringArray(evidence.breakReasons)
    strings(evidence, ['cacheMode'])
  } else if (event.kind === 'process/observed') {
    const identity = record(event.identity)
    numbers(identity, ['pid', 'registeredAt'])
    strings(identity, ['nodeId', 'verification'])
    if (!['confirmed', 'unknown', 'dead'].includes(String(event.liveness))) throw new Error('Invalid process observation')
  } else if (event.kind === 'alert') {
    const alert = record(event.alert)
    strings(alert, ['code', 'message'])
    if (typeof alert.redacted !== 'boolean') throw new Error('Invalid alert redaction evidence')
  } else if (event.kind === 'compaction') numbers(event, ['committedSeq', 'committedAt'])
  else if (event.kind === 'delivery') stringArray(event.paths)
  else if (event.kind === 'retry') {
    numbers(event, ['attemptIndex'])
    strings(event, ['logicalRequestId', 'phase'])
  } else if (event.kind === 'policy/denied') strings(event, ['operation', 'requested', 'definition', 'reason'])
}

function validateEvent(value: unknown): LedgerEvent {
  assertEvent(value)
  return value
}

function frame(payload: unknown, maxBytes: number): Buffer {
  const text = canonicalJson(payload)
  const encoded = Buffer.from(canonicalJson({ version: 1, bytes: Buffer.byteLength(text), digest: digest(text), payload }) + '\n')
  if (encoded.length > maxBytes) throw new Error('Ledger record exceeds configured size limit')
  return encoded
}

function decode(line: Buffer, maxBytes: number): unknown {
  if (line.length > maxBytes) throw new Error('Ledger record exceeds configured size limit')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(line)
  const outer = record(JSON.parse(text))
  const payload = canonicalJson(outer.payload)
  if (outer.version !== 1 || outer.bytes !== Buffer.byteLength(payload) || outer.digest !== digest(payload)) throw new Error('Ledger checksum or length mismatch')
  return outer.payload
}

async function durableFile(path: string, encoded: Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    let offset = 0
    while (offset < encoded.length) {
      const { bytesWritten } = await handle.write(encoded, offset, encoded.length - offset)
      if (bytesWritten <= 0) throw new Error('Ledger write made no progress')
      offset += bytesWritten
    }
    await handle.sync()
  } finally { await handle.close() }
  await syncDirectory(dirname(path))
}

async function syncFiles(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const handle = await open(path, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    await syncDirectory(dirname(path))
  }
}

/** Scan every UTC partition; incomplete final lines are retained, never joined to later appends.
 * @param root - One node directory.
 * @param maxRecordBytes - Maximum accepted encoded record size.
 * @returns Valid complete records and explicit tail/corruption evidence.
 */
export async function recoverSegments(root: string, maxRecordBytes: number): Promise<LedgerScan> {
  const events: LedgerEvent[] = []
  const tails: string[] = []
  const corrupt: string[] = []
  const marks: string[] = []
  for (const path of await files(join(root, 'events'))) {
    const content = await readFile(path)
    let start = 0
    let end: number
    while ((end = content.indexOf(10, start)) !== -1) {
      try {
        const event = validateEvent(decode(content.subarray(start, end), maxRecordBytes))
        events.push(event)
        marks.push(digest(canonicalJson(event)))
      } catch (error) {
        // A corrupt complete line is never treated as an interrupted append.
        if (!(error instanceof Error)) throw error
        corrupt.push(path)
      }
      start = end + 1
    }
    if (start !== content.length) tails.push(path)
  }
  let importedConflicts = false
  for (const path of await files(join(root, 'imports'))) {
    const content = await readFile(path)
    try {
      if (content.at(-1) !== 10) throw new Error('Incomplete import manifest')
      const manifest = record(decode(content.subarray(0, -1), maxRecordBytes))
      if (!Array.isArray(manifest.conflicts)) throw new Error('Invalid import manifest')
      importedConflicts ||= manifest.conflicts.length > 0
    } catch (error) {
      if (!(error instanceof Error)) throw error
      corrupt.push(path)
    }
  }
  return {
    events, complete: !corrupt.length && !tails.length && !importedConflicts,
    tails, corrupt, watermark: digest(marks.join('\n')) as LedgerWatermark,
  }
}

/** Persist or compare one semantic slot while holding the node's stable-inode writer lock.
 * @param root - Local node directory.
 * @param event - Immutable complete event.
 * @param options - Storage limits and native-lock wait budget.
 * @param firstTerminalWins - Only finishRun may accept a different already committed terminal fact.
 * @returns Durable append/existing outcome or a non-overwriting conflict.
 */
export async function appendUnique(
  root: string, event: LedgerEvent, options: JournalOptions, firstTerminalWins = false,
): Promise<LedgerAppendResult> {
  const immutable = validateEvent(JSON.parse(canonicalJson(event)))
  const encoded = frame(immutable, options.maxRecordBytes)
  await ensureDirectory(root)
  return withWriterLock(join(root, 'writer.lock'), options, async () => {
    const scan = await recoverSegments(root, options.maxRecordBytes)
    if (scan.corrupt.length) throw new Error('Ledger corruption prevents further writes')
    const index = rebuildIndex(scan.events)
    if (index.conflicts.length) throw new Error('Ledger contains conflicting unique slots')
    await syncFiles(await files(join(root, 'events')))
    const priorId = index.events.get(immutable.eventId)
    const key = uniqueSlot(immutable)
    const priorSlot = key === undefined ? undefined : index.slots.get(key)
    const prior = priorId ?? priorSlot
    if (prior) {
      const equal = priorId ? canonicalJson(prior) === canonicalJson(immutable) : slotContent(prior) === slotContent(immutable)
      const acceptedTerminal = firstTerminalWins && immutable.kind === 'run/end'
        && prior.kind === 'run/end' && prior.data.runId === immutable.data.runId
      if (!equal && !acceptedTerminal) {
        return { kind: 'conflict', eventId: immutable.eventId, existingDigest: digest(canonicalJson(prior)), incomingDigest: digest(canonicalJson(immutable)) }
      }
      // A previous writer may have lost its fsync acknowledgement; a replay must synchronize again.
      await syncFiles(await files(join(root, 'events')))
      return { kind: 'existing', event: prior, watermark: scan.watermark }
    }
    const directory = join(root, 'events', new Date().toISOString().slice(0, 10))
    await ensureDirectory(directory)
    for (const tail of scan.tails) {
      const recoveryId = `recovery:${digest(relativePath(root, tail))}` as LedgerEvent['eventId']
      if (index.events.has(recoveryId)) continue
      const recovery: LedgerEvent = {
        schemaVersion: 1, eventId: recoveryId, nodeId: immutable.nodeId,
        runId: immutable.runId, sessionId: immutable.sessionId, observedAt: Date.now(), kind: 'alert',
        alert: { code: 'ledger-tail-recovered', message: 'An incomplete journal tail was preserved; writing resumed in a new segment.', redacted: false },
      }
      await durableFile(join(directory, `${randomUUID()}.jsonl`), frame(recovery, options.maxRecordBytes))
    }
    await durableFile(join(directory, `${randomUUID()}.jsonl`), encoded)
    const after = await recoverSegments(root, options.maxRecordBytes)
    return { kind: 'appended', event: immutable, watermark: after.watermark }
  })
}

/** Initialize a random persistent node identity under a root-level writer lock.
 * @param root - Ledger version directory beneath the resolved Harness home.
 * @param options - Native-lock contention budget.
 * @returns Stable local node identity, never a network address.
 */
export async function resolveNodeId(root: string, options: WriterLockOptions): Promise<LedgerNodeId> {
  await ensureDirectory(root)
  return withWriterLock(join(root, 'writer.lock'), options, async () => {
    const path = join(root, 'node-id')
    let id: string
    try { id = await readFile(path, 'utf8') } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error
      id = randomUUID()
      await durableFile(path, Buffer.from(id))
    }
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid persistent ledger node identity')
    await syncFiles([path])
    return id as LedgerNodeId
  })
}

/** Validate all source segments before importing any fact; keep a durable source manifest.
 * @param root - Destination node directory.
 * @param source - Read-only source node directory, never used as a write destination.
 * @param options - Local size and lock budgets.
 * @returns Per-fact outcomes, including conflicts without silently selecting a winner.
 */
export async function importSegments(root: string, source: string, options: JournalOptions): Promise<LedgerAppendResult[]> {
  const scan = await recoverSegments(source, options.maxRecordBytes)
  if (!scan.complete) throw new Error('Import requires complete, valid source segments')
  const results: LedgerAppendResult[] = []
  for (const event of scan.events) results.push(await appendUnique(root, event, options))
  const directory = join(root, 'imports')
  await ensureDirectory(directory)
  await withWriterLock(join(root, 'writer.lock'), options, async () => {
    await durableFile(join(directory, `${randomUUID()}.jsonl`), frame({
      version: 1, watermark: scan.watermark,
      events: scan.events.map(event => ({ eventId: event.eventId, nodeId: event.nodeId, digest: digest(canonicalJson(event)) })),
      conflicts: results.filter(result => result.kind === 'conflict'),
    }, options.maxRecordBytes))
  })
  return results
}

type ArtifactRecord = { type: 'fragment'; input: LedgerArtifactAppend; path: string }
  | { type: 'closed'; reference: LedgerArtifactReference }

function artifactPath(input: Pick<LedgerArtifactAppend, 'callId' | 'kind'>): string {
  return `artifacts/${digest(input.callId)}/${input.kind}`
}

function assertArtifactAppend(value: unknown): asserts value is LedgerArtifactAppend {
  const input = record(value)
  if (typeof input.callId !== 'string' || typeof input.content !== 'string'
    || !Number.isSafeInteger(input.seq) || Number(input.seq) < 0
    || !['partial-response', 'keepalive-request'].includes(String(input.kind))) throw new Error('Invalid artifact fragment')
  JSON.parse(input.content)
}

async function artifactRecords(root: string, relative: string, maxBytes: number): Promise<ArtifactRecord[]> {
  const records: ArtifactRecord[] = []
  for (const path of await files(join(root, relative))) {
    const bytes = await readFile(path)
    const end = bytes.indexOf(10)
    if (end < 0) continue
    if (end !== bytes.length - 1) throw new Error('Invalid artifact segment framing')
    const value = record(decode(bytes.subarray(0, end), maxBytes))
    if (value.type !== 'fragment' && value.type !== 'closed') throw new Error('Invalid artifact record')
    if (value.type === 'fragment') {
      const input = value.input
      assertArtifactAppend(input)
      records.push({ type: 'fragment', input, path: relativePath(root, path) })
    } else {
      record(value.reference)
      records.push(value as ArtifactRecord)
    }
  }
  return records
}

function referenceOf(input: LedgerArtifactAppend, path: string): LedgerArtifactReference {
  return { callId: input.callId, kind: input.kind, seq: input.seq, path, digest: digest(input.content) }
}

/** Append exact serialized JSON bytes to a contiguous call-owned sidecar stream.
 * @param root - Node directory owning the stream.
 * @param input - Fragment identity and unmodified serialized content.
 * @param options - Native lock and record size limits.
 * @returns Durable reference or an explicit conflicting digest pair.
 */
export async function appendArtifact(
  root: string, input: LedgerArtifactAppend, options: JournalOptions,
): Promise<LedgerArtifactAppendResult> {
  if (!Number.isSafeInteger(input.seq) || input.seq < 0 || !['partial-response', 'keepalive-request'].includes(input.kind)) throw new Error('Invalid artifact key')
  JSON.parse(input.content)
  if (Buffer.from(input.content).toString('utf8') !== input.content) throw new Error('Artifact content must be lossless UTF-8')
  const encoded = frame({ type: 'fragment', input }, options.maxRecordBytes)
  await ensureDirectory(root)
  return withWriterLock(join(root, 'writer.lock'), options, async () => {
    const relative = artifactPath(input)
    const records = await artifactRecords(root, relative, options.maxRecordBytes)
    const fragments = records.filter(item => item.type === 'fragment')
      .sort((a, b) => a.input.seq - b.input.seq)
    const prior = fragments.find(item => item.input.seq === input.seq)
    if (prior) {
      if (prior.input.content !== input.content) return {
        kind: 'conflict', key: { callId: input.callId, kind: input.kind, seq: input.seq },
        existingDigest: digest(prior.input.content), incomingDigest: digest(input.content),
      }
      await syncFiles(await files(join(root, relative)))
      return { kind: 'existing', reference: referenceOf(prior.input, prior.path) }
    }
    if (records.some(item => item.type === 'closed')) throw new Error('Artifact stream is already closed')
    if (fragments.some((item, seq) => item.input.seq !== seq) || input.seq !== fragments.length) {
      throw new Error('Artifact sequence must be contiguous')
    }
    const directory = join(root, relative, String(input.seq))
    await ensureDirectory(directory)
    const path = `${relative}/${input.seq}/${randomUUID()}.jsonl`
    await durableFile(join(root, path), encoded)
    return { kind: 'appended', reference: referenceOf(input, path) }
  })
}

/** Durably seal a stream after validating its final persisted fragment.
 * @param root - Owning node directory.
 * @param reference - Exact last-fragment reference returned by appendArtifact.
 * @param options - Native lock and record size limits.
 * @returns Idempotent closure acknowledgement after fsync.
 */
export async function finishArtifact(
  root: string, reference: LedgerArtifactReference, options: JournalOptions,
): Promise<LedgerArtifactFinishResult> {
  await ensureDirectory(root)
  return withWriterLock(join(root, 'writer.lock'), options, async () => {
    const relative = artifactPath(reference)
    const records = await artifactRecords(root, relative, options.maxRecordBytes)
    const fragments = records.filter(item => item.type === 'fragment')
      .sort((a, b) => a.input.seq - b.input.seq)
    const last = fragments.at(-1)
    if (!last || fragments.some((item, seq) => item.input.seq !== seq)
      || canonicalJson(referenceOf(last.input, last.path)) !== canonicalJson(reference)) {
      throw new Error('Artifact closure does not reference the final durable fragment')
    }
    const closed = records.find(item => item.type === 'closed')
    if (closed) {
      if (canonicalJson(closed.reference) !== canonicalJson(reference)) throw new Error('Conflicting artifact closure')
      await syncFiles(await files(join(root, relative)))
      return { kind: 'existing', reference }
    }
    await syncFiles(await files(join(root, relative)))
    await durableFile(join(root, relative, `closed-${randomUUID()}.jsonl`), frame({ type: 'closed', reference }, options.maxRecordBytes))
    return { kind: 'finished', reference }
  })
}
