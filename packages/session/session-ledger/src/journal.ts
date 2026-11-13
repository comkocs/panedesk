/** Append-only, checksummed JSONL segments with native-lock serialization and durable acknowledgements. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, realpath, stat, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ledgerRelative } from './paths.ts'
import { addToIndex, canonicalJson, digest, rebuildIndex, slotContent, uniqueSlot, type LedgerIndex } from './index-store.ts'
import { ledgerUuid } from './random.ts'
import { foldLedger, LedgerProjection } from './projection.ts'
import { withWriterLock, type WriterLockOptions } from './lock.ts'
import type { LedgerAppendResult, LedgerArtifactAppend, LedgerArtifactAppendResult, LedgerArtifactFinishResult, LedgerArtifactReference, LedgerEvent, LedgerEventId, LedgerNodeId, LedgerWatermark, MessageLedgerEvent } from './types.ts'
import type { MessageCursor } from '@panedesk/dsh-message-delivery'

/** Explicit local storage limits shared by every writer and scanner. */
export interface JournalOptions extends WriterLockOptions {
  maxRecordBytes: number
  /** Receives committed facts for optional mirrors; never performs local persistence. */
  committed?: (event: LedgerEvent) => void
  /** Service-owned shared-view lifetime; absent owners use transaction-local views. */
  viewOwner?: JournalViewOwner
  /** Test-only interruption observer; absent in provider configuration and normal writes. */
  appendCheckpoint?: (phase: 'partial-write' | 'before-file-sync' | 'before-directory-sync') => Promise<void>
}

/** Validated scan results expose uncommitted tails and corruption without discarding bytes. */
export interface LedgerScan {
  events: LedgerEvent[]
  complete: boolean
  tails: string[]
  corrupt: string[]
  watermark: LedgerWatermark
}

/** Synchronize a directory; only unsupported Windows directory open and sync errors are tolerated.
 * File synchronization, directory close and non-Windows failures still propagate.
 * @param path - Existing directory owned by the ledger.
 * @param platform - Host platform, defaulting to the current host.
 * @param openDirectory - Directory-only opener, defaulting to the host filesystem.
 */
export async function syncDirectory(path: string, platform: NodeJS.Platform = process.platform,
  openDirectory: (path: string, flags: string) => Promise<Pick<FileHandle, 'sync' | 'close'>> = open): Promise<void> {
  const unsupported = (error: unknown): boolean => platform === 'win32' && error !== null && typeof error === 'object'
    && 'code' in error && ['EPERM', 'EISDIR', 'EINVAL'].includes(String(error.code))
  let handle: Pick<FileHandle, 'sync' | 'close'>
  try { handle = await openDirectory(path, 'r') }
  catch (error) { if (unsupported(error)) return; throw error }
  try {
    try { await handle.sync() }
    catch (error) { if (!unsupported(error)) throw error }
  } finally { await handle.close() }
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
  const kinds = ['activity/start', 'activity/end', 'call/start', 'call/end', 'run/start', 'run/end', 'wait/start', 'wait/end', 'cache/break', 'cache/evidence', 'retry', 'compaction', 'alert', 'delivery', 'process/observed', 'policy/denied']
  if (!kinds.includes(String(event.kind))) throw new Error('Unknown ledger event kind')
  if (event.kind === 'activity/start') {
    strings(event, ['activityId', 'taskId', 'category'])
    numbers(event, ['taskStartedAt', 'startedAt'])
    stringArray(event.ancestorTaskIds)
    if (typeof event.selfWrittenScript !== 'boolean') throw new Error('Invalid activity script tag')
  } else if (event.kind === 'activity/end') {
    strings(event, ['activityId', 'taskId'])
    numbers(event, ['durationMs'])
    stringArray(event.createdFiles)
  } else if (String(event.kind).startsWith('call/') || String(event.kind).startsWith('run/')) {
    const data = record(event.data)
    if (String(event.kind).startsWith('call/') && (typeof data.callId !== 'string' || data.callId !== event.callId)) throw new Error('Mismatched ledger call identity')
    if (String(event.kind).startsWith('run/') && data.runId !== event.runId) throw new Error('Mismatched ledger run identity')
    if (String(event.kind).endsWith('/start')) {
      strings(data, ['seat', 'window', 'rootSessionId', 'accountLabel', 'identitySource'])
      if (event.kind === 'call/start') {
        strings(data, ['logicalRequestId', 'provider', 'modelFamily', 'requestedModel', 'purpose', 'priceVersion', 'priceKey'])
        numbers(data, ['attemptIndex', 'startedAt'])
        if (data.requestHeaderSeq !== undefined
          && (typeof data.requestHeaderSeq !== 'number' || !Number.isSafeInteger(data.requestHeaderSeq) || data.requestHeaderSeq < 0)) {
          throw new Error('Invalid request header sequence')
        }
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

/** Validate a persisted body-free ledger event before projection or mirroring. */
export function validateEvent(value: unknown): LedgerEvent {
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

function* completeLines(content: Buffer): Generator<Buffer> {
  let start = 0
  let end: number
  while ((end = content.indexOf(10, start)) !== -1) {
    yield content.subarray(start, end)
    start = end + 1
  }
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
    for (const line of completeLines(content)) {
      try {
        const event = validateEvent(decode(line, maxRecordBytes))
        events.push(event)
        marks.push(digest(canonicalJson(event)))
      } catch (error) {
        // A corrupt complete line is never treated as an interrupted append.
        if (!(error instanceof Error)) throw error
        corrupt.push(path)
      }
    }
    if (content.length > 0 && content.at(-1) !== 10) tails.push(path)
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

interface SegmentView {
  offset: number
  events: LedgerEvent[]
  marks: string[]
  tail: boolean
  corrupt: boolean
  importedConflicts: boolean
}

/** Service lifetime retaining shared node views until its final release. */
export class JournalViewOwner {
  private readonly releases = new Map<string, () => void>()
  private disposed = false

  /** Retain one view per storage identity for this owner.
   * @param key - Canonical node, lock identity and decoder limit.
   * @param retain - Acquire a reference and return its release.
   */
  retain(key: string, retain: () => () => void): void {
    if (!this.disposed && !this.releases.has(key)) this.releases.set(key, retain())
  }

  /** Release all retained views; in-flight transactions keep their own references. */
  dispose(): void {
    this.disposed = true
    for (const release of this.releases.values()) release()
    this.releases.clear()
  }
}

/** Shared node views are retained only by explicit service owners. */
class JournalView {
  private static readonly nodes = new Map<string, JournalView>()
  readonly segments = new Map<string, SegmentView>()
  readonly index: LedgerIndex = rebuildIndex([])
  readonly eventFiles = new Map<string, string>()
  readonly waitFacts = new Map<string, LedgerEvent[]>()
  readonly latestStarts = new Map<string, LedgerEvent[]>()
  readonly openRuns = new Map<string, Map<string, LedgerEvent>>()
  readonly artifactClosures = new Map<string, { identity: string; seq: number | undefined }>()
  writer: { path: string; date: string } | undefined

  private references = 0
  private projection = new LedgerProjection()
  private readonly projectedLengths = new Map<string, number>()
  private watermarkSnapshot: (() => LedgerWatermark) | undefined

  snapshot(options: Parameters<typeof foldLedger>[1]): ReturnType<typeof foldLedger> {
    const complete = ![...this.segments.values()].some(segment => segment.tail || segment.corrupt || segment.importedConflicts)
    const settings = { ...options, complete,
      watermarks: { [options.localNodeId ?? '']: this.captureWatermark()() } }
    if (this.index.conflicts.length) return foldLedger(this.scan('').events, settings)
    for (const [path, segment] of this.segments) {
      const length = this.projectedLengths.get(path) ?? 0
      if (length === segment.events.length) continue
      this.projection.apply(segment.events.slice(length))
      this.projectedLengths.set(path, segment.events.length)
    }
    return this.projection.snapshot(settings)
  }

  static async forRoot(root: string, options: JournalOptions): Promise<JournalView> {
    const identity = await stat(join(root, 'writer.lock'), { bigint: true })
    const key = JSON.stringify([root, String(identity.dev), String(identity.ino), options.maxRecordBytes])
    let view = this.nodes.get(key)
    if (!view) view = new JournalView()
    const retained = view
    options.viewOwner?.retain(key, () => {
      this.nodes.set(key, retained)
      retained.references++
      return () => {
        if (--retained.references === 0) this.nodes.delete(key)
      }
    })
    return view
  }

  accept(path: string, segment: SegmentView, event: LedgerEvent): void {
    this.watermarkSnapshot = undefined
    segment.events.push(event)
    segment.marks.push(digest(canonicalJson(event)))
    addToIndex(this.index, event)
    if (event.kind === 'wait/start' || event.kind === 'wait/end') {
      const key = JSON.stringify([event.nodeId, event.sessionId, event.runId, event.interval.toolCallId])
      const facts = this.waitFacts.get(key) ?? []
      facts.push(event)
      this.waitFacts.set(key, facts)
    }
    if (event.kind === 'call/start' || event.kind === 'run/start') {
      const facts = this.latestStarts.get(event.sessionId) ?? []
      const latest = facts[0]
      const time = latest && (latest.kind === 'call/start' || latest.kind === 'run/start') ? latest.data.startedAt : -Infinity
      if (event.data.startedAt > time) this.latestStarts.set(event.sessionId, [event])
      else if (event.data.startedAt === time) { facts.push(event); this.latestStarts.set(event.sessionId, facts) }
    }
    if (event.kind === 'run/start' || event.kind === 'run/end') {
      const runs = this.openRuns.get(event.sessionId) ?? new Map<string, LedgerEvent>()
      if (event.kind === 'run/start' && !this.index.slots.has(JSON.stringify(['run/end', event.runId]))) runs.set(event.runId, event)
      else runs.delete(event.runId)
      this.openRuns.set(event.sessionId, runs)
    }
    if (!this.eventFiles.has(event.eventId)) this.eventFiles.set(event.eventId, path)
  }

  async refresh(root: string, maxBytes: number): Promise<void> {
    const paths = [...await files(join(root, 'events')), ...await files(join(root, 'imports'))]
      .map(path => ledgerRelative(root, path))
    const present = new Set(paths)
    if ([...this.segments.keys()].some(path => !present.has(path))) {
      // Administrative moves invalidate positions; normal writers never remove journal files.
      this.watermarkSnapshot = undefined
      this.segments.clear()
      this.projection = new LedgerProjection()
      this.projectedLengths.clear()
      this.index.events.clear(); this.index.slots.clear(); this.index.conflicts.length = 0
      this.eventFiles.clear(); this.waitFacts.clear(); this.latestStarts.clear(); this.openRuns.clear(); this.writer = undefined
    }
    for (const path of paths) {
      const previous = this.segments.get(path)
      // Legacy writers publish immutable UUID-named facts; unknown names remain monitored.
      if (previous && /\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.jsonl$/.test(path)) continue
      const absolute = join(root, path)
      const size = (await stat(absolute)).size
      if (previous && previous.offset === size) continue
      if (previous && size < previous.offset) throw new Error('Ledger segment was truncated')
      const handle = await open(absolute, 'r+')
      let content: Buffer
      try {
        const offset = previous?.offset ?? 0
        content = Buffer.alloc(size - offset)
        let read = 0
        while (read < content.length) {
          const result = await handle.read(content, read, content.length - read, offset + read)
          if (!result.bytesRead) throw new Error('Ledger segment changed during refresh')
          read += result.bytesRead
        }
        await handle.sync()
      } finally { await handle.close() }
      if (!previous) await syncDirectory(dirname(absolute))
      const segment = previous ?? { offset: 0, events: [], marks: [], tail: false, corrupt: false, importedConflicts: false }
      if (previous?.tail) segment.corrupt = true
      if (path.startsWith('imports/')) {
        try {
          if (content.at(-1) !== 10) throw new Error('Incomplete import manifest')
          const manifest = record(decode(content.subarray(0, -1), maxBytes))
          if (!Array.isArray(manifest.conflicts)) throw new Error('Invalid import manifest')
          segment.importedConflicts = manifest.conflicts.length > 0
        } catch (error) { if (!(error instanceof Error)) throw error; segment.corrupt = true }
      } else {
        for (const line of completeLines(content)) {
          try { this.accept(path, segment, validateEvent(decode(line, maxBytes))) }
          catch (error) { if (!(error instanceof Error)) throw error; segment.corrupt = true }
        }
        segment.tail ||= content.length > 0 && content.at(-1) !== 10
      }
      segment.offset = size
      this.segments.set(path, segment)
    }
  }

  private orderedSegments(): [string, SegmentView][] {
    return [...this.segments].sort(([a], [b]) => {
      const left = a.split('/'); const right = b.split('/')
      for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const part = left[i]; const other = right[i]
        if (part === undefined || other === undefined) break
        const order = part.localeCompare(other)
        if (order) return order
      }
      return left.length - right.length
    })
  }

  private captureWatermark(): () => LedgerWatermark {
    if (this.watermarkSnapshot) return this.watermarkSnapshot
    // Marks are append-only. Fixed lengths preserve this acknowledgement after later writes or view release.
    let state: { snapshot: { marks: string[]; length: number }[] } | { watermark: LedgerWatermark } = {
      snapshot: this.orderedSegments().map(([, segment]) => ({ marks: segment.marks, length: segment.marks.length })),
    }
    this.watermarkSnapshot = () => {
      if ('snapshot' in state) {
        state = { watermark: digest(state.snapshot.flatMap(({ marks, length }) => marks.slice(0, length)).join('\n')) as LedgerWatermark }
      }
      return state.watermark
    }
    return this.watermarkSnapshot
  }

  acknowledgement(kind: 'appended' | 'existing', event: LedgerEvent): LedgerAppendResult {
    const readWatermark = this.captureWatermark()
    let assigned: LedgerWatermark | undefined
    return { kind, event: structuredClone(event),
      get watermark() { return assigned ?? readWatermark() },
      set watermark(value: LedgerWatermark) { assigned = value },
    }
  }

  scan(root: string): LedgerScan {
    const ordered = this.orderedSegments()
    const tails = ordered.filter(([, value]) => value.tail).map(([path]) => join(root, path))
    const corrupt = ordered.filter(([, value]) => value.corrupt).map(([path]) => join(root, path))
    return { events: ordered.flatMap(([, value]) => value.events), tails, corrupt,
      complete: !tails.length && !corrupt.length && !ordered.some(([, value]) => value.importedConflicts),
      watermark: digest(ordered.flatMap(([, value]) => value.marks).join('\n')) as LedgerWatermark }
  }

  assertWritable(): void {
    if ([...this.segments.values()].some(segment => segment.corrupt)) throw new Error('Ledger corruption prevents further writes')
    if (this.index.conflicts.length) throw new Error('Ledger contains conflicting unique slots')
  }

  async append(root: string, event: LedgerEvent, encoded: Buffer, checkpoint: JournalOptions['appendCheckpoint']): Promise<void> {
    const date = new Date().toISOString().slice(0, 10)
    const directory = join(root, 'events', date)
    const fresh = this.writer === undefined || this.writer.date !== date
    if (fresh) await ensureDirectory(directory)
    if (fresh) this.writer = { path: ledgerRelative(root, join(directory, `segment-${ledgerUuid()}.jsonl`)), date }
    // Preserve upstream non-call UUID consumption without creating a file per fact.
    if (event.kind !== 'call/start' && event.kind !== 'call/end') randomUUID()
    const writer = this.writer
    if (!writer) throw new Error('Ledger writer segment is unavailable')
    try {
      const handle = await open(join(root, writer.path), fresh ? 'wx' : 'a', 0o600)
      try {
        let offset = 0
        while (offset < encoded.length) {
          const length = checkpoint && offset === 0 ? Math.max(1, Math.floor(encoded.length / 2)) : encoded.length - offset
          const { bytesWritten } = await handle.write(encoded, offset, length)
          if (bytesWritten <= 0) throw new Error('Ledger write made no progress')
          offset += bytesWritten
          if (offset < encoded.length) await checkpoint?.('partial-write')
        }
        await checkpoint?.('before-file-sync')
        await handle.sync()
      } finally { await handle.close() }
      if (fresh) { await checkpoint?.('before-directory-sync'); await syncDirectory(directory) }
      const segment = this.segments.get(writer.path)
        ?? { offset: 0, events: [], marks: [], tail: false, corrupt: false, importedConflicts: false }
      this.accept(writer.path, segment, event)
      segment.offset += encoded.length
      this.segments.set(writer.path, segment)
    } catch (error) { this.writer = undefined; throw error }
  }
}

/** Read refreshed facts under the node lock without rereading synchronized bytes.
 * @param root - Existing node directory.
 * @param options - Lock and record limits.
 * @returns Detached scan retaining the historical persisted watermark algorithm.
 */
export async function readJournal(root: string, options: JournalOptions): Promise<LedgerScan> {
  root = await realpath(root)
  return withWriterLock(join(root, 'writer.lock'), options, async () => {
    const view = await JournalView.forRoot(root, options)
    await view.refresh(root, options.maxRecordBytes)
    return structuredClone(view.scan(root))
  })
}

/** Read the complete incremental projection; reads never walk the artifact store, so the writer lock stays short.
 * @param root - Existing node directory.
 * @param options - Storage limits and service-owned view lifetime.
 * @param projection - Read instant, local identity, freshness and selection.
 * @returns Detached rows with the unchanged journal watermark and conflict semantics.
 */
export async function readJournalSnapshot(root: string, options: JournalOptions,
  projection: Parameters<typeof foldLedger>[1]): Promise<ReturnType<typeof foldLedger>> {
  root = await realpath(root)
  return withWriterLock(join(root, 'writer.lock'), options, async () => {
    const view = await JournalView.forRoot(root, options)
    await view.refresh(root, options.maxRecordBytes)
    return view.snapshot(projection)
  })
}

/** Read committed call facts under the same writer lock as the local snapshot. */
export async function readJournalEvents(root: string, options: JournalOptions): Promise<{ events: LedgerEvent[]; complete: boolean }> {
  root = await realpath(root)
  return withWriterLock(join(root, 'writer.lock'), options, async () => {
    const view = await JournalView.forRoot(root, options)
    await view.refresh(root, options.maxRecordBytes)
    return { events: [...view.index.events.values()], complete: view.snapshot({ asOf: Date.now(), observationMaxAgeMs: 10000 }).complete }
  })
}

/** Read keyed facts; conflicting journals retain full projection semantics.
 * @param root - Existing canonical node directory.
 * @param options - Storage limits and service-owned view lifetime.
 * @param selection - Exact wait identity or session start selection.
 * @returns Detached facts and journal completeness, without calculating a watermark.
 */
export async function readJournalFacts(root: string, options: JournalOptions, selection:
  | { kind: 'waits'; nodeId: string; sessionId: string; runId: string; toolCallIds: readonly string[] }
  | { kind: 'latest-start' | 'open-runs'; sessionId: string },
): Promise<{ events: LedgerEvent[]; complete: boolean }> {
  root = await realpath(root)
  return withWriterLock(join(root, 'writer.lock'), options, async () => {
    const view = await JournalView.forRoot(root, options)
    await view.refresh(root, options.maxRecordBytes)
    let events: LedgerEvent[]
    if (selection.kind === 'waits') {
      events = selection.toolCallIds.flatMap(id => view.waitFacts.get(JSON.stringify([
        selection.nodeId, selection.sessionId, selection.runId, id,
      ])) ?? [])
    } else events = selection.kind === 'latest-start'
      ? view.latestStarts.get(selection.sessionId) ?? []
      : [...view.openRuns.get(selection.sessionId)?.values() ?? []]
    const run = events[0]
    if (selection.kind === 'open-runs' && events.length === 1 && run !== undefined) {
      const end = view.index.slots.get(JSON.stringify(['run/end', run.runId]))
      if (end) events = [...events, end]
    }
    // Ambiguous ordering and corrupt identities use the unchanged full projection path.
    if (view.index.conflicts.length || selection.kind !== 'waits' && events.length > 1) events = view.scan(root).events
    const complete = ![...view.segments.values()].some(segment => segment.tail || segment.corrupt || segment.importedConflicts)
    return structuredClone({ events, complete })
  })
}

/** Persist or compare one semantic slot while holding the node's stable-inode writer lock.
 * @param root - Local node directory.
 * @param event - Complete event, or a factory resolving its start from the locked index.
 * @param options - Storage limits and native-lock wait budget.
 * @param firstTerminalWins - Only finishRun may accept a different already committed terminal fact.
 * @returns Durable append/existing outcome with a lazily cached, transaction-pinned watermark, or a non-overwriting conflict.
 */
export async function appendUnique(
  root: string, event: LedgerEvent | ((index: LedgerIndex) => LedgerEvent), options: JournalOptions, firstTerminalWins = false,
): Promise<LedgerAppendResult> {
  await ensureDirectory(root)
  root = await realpath(root)
  return withWriterLock(join(root, 'writer.lock'), options, async () => {
    const view = await JournalView.forRoot(root, options)
    await view.refresh(root, options.maxRecordBytes)
    view.assertWritable()
    const index = view.index
    const immutable = validateEvent(JSON.parse(canonicalJson(typeof event === 'function' ? event(index) : event)))
    const encoded = frame(immutable, options.maxRecordBytes)
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
      const path = view.eventFiles.get(prior.eventId)
      if (path === undefined) throw new Error('Ledger fact has no synchronized segment')
      await syncFiles([join(root, path)])
      options.committed?.(prior)
      return view.acknowledgement('existing', prior)
    }
    for (const [tail, segment] of view.segments) {
      if (!segment.tail) continue
      const relative = ledgerRelative(root, join(root, tail))
      const recoveryId = `recovery:${digest(relative)}` as LedgerEvent['eventId']
      const legacyRecoveryId = `recovery:${digest(relative.replaceAll('/', '\\'))}`
      if (index.events.has(recoveryId) || index.events.has(legacyRecoveryId)) continue
      const recovery: LedgerEvent = {
        schemaVersion: 1, eventId: recoveryId, nodeId: immutable.nodeId,
        runId: immutable.runId, sessionId: immutable.sessionId, observedAt: Date.now(), kind: 'alert',
        alert: { code: 'ledger-tail-recovered', message: 'An incomplete journal tail was preserved; writing resumed in a new segment.', redacted: false },
      }
      await view.append(root, recovery, frame(recovery, options.maxRecordBytes), options.appendCheckpoint)
      options.committed?.(recovery)
    }
    await view.append(root, immutable, encoded, options.appendCheckpoint)
    options.committed?.(immutable)
    return view.acknowledgement('appended', immutable)
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
  await validateArtifactClosures(source, options.maxRecordBytes)
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

/** Derive a stable message fact identity without including transport timestamps.
 * @param event - Runtime node and message transition identity.
 * @returns Deterministic identity for idempotent outbox replay.
 */
export function messageEventId(event: { nodeId: LedgerNodeId; data: import('@panedesk/dsh-message-delivery').MessageStateData }): LedgerEventId {
  return `message/state:${digest(canonicalJson([event.nodeId, event.data.messageId, event.data.stateVersion, event.data.transition]))}` as LedgerEventId
}

function assertMessageEvent(value: unknown): asserts value is MessageLedgerEvent {
  const event = record(value)
  const data = record(event.data)
  if (event.kind === 'message/quarantined') {
    if (Object.keys(event).some(key => !['schemaVersion', 'eventId', 'nodeId', 'observedAt', 'kind', 'data'].includes(key))
      || Object.keys(data).some(key => !['messageId', 'reason', 'originalFileName'].includes(key))) throw new Error('Unexpected quarantine field')
    if (event.schemaVersion !== 1) throw new Error('Invalid message ledger version')
    strings(event, ['eventId', 'nodeId'])
    numbers(event, ['observedAt'])
    strings(data, ['originalFileName'])
    if (data.messageId !== undefined) strings(data, ['messageId'])
    if (!['corrupt', 'unsupported-version', 'invalid-fields'].includes(String(data.reason))) throw new Error('Invalid quarantine reason')
    return
  }
  const allowed = ['messageId', 'senderSessionId', 'targetSessionId', 'priority', 'messageClass', 'state', 'revision', 'stateVersion', 'operationId', 'transition', 'observedAt', 'reason', 'firstRequestId', 'firstTurnId', 'deliveryOutcome', 'pending']
  if (Object.keys(event).some(key => !['schemaVersion', 'eventId', 'nodeId', 'observedAt', 'kind', 'data'].includes(key))
    || Object.keys(data).some(key => !allowed.includes(key))) throw new Error('Unexpected message ledger field')
  if (event.schemaVersion !== 1 || event.kind !== 'message/state') throw new Error('Invalid message ledger version or kind')
  strings(event, ['eventId', 'nodeId'])
  strings(data, ['messageId', 'operationId'])
  numbers(event, ['observedAt'])
  numbers(data, ['observedAt', 'revision', 'stateVersion'])
  if (event.observedAt !== data.observedAt || !Number.isSafeInteger(data.revision) || !Number.isSafeInteger(data.stateVersion)) throw new Error('Invalid message ledger version or time')
  for (const key of ['senderSessionId', 'targetSessionId']) {
    if (data[key] !== null && (typeof data[key] !== 'string' || !data[key])) throw new Error('Invalid message session identity')
  }
  for (const [key, values] of [
    ['priority', ['immediate', 'steer', 'queue']],
    ['messageClass', ['handoff', 'notice', 'reply']],
    ['state', ['queued', 'injected', 'responded', 'withdrawn', 'invalidated', 'rejected']],
    ['transition', ['accepted', 'rejected', 'claimed', 'appended', 'rolled-back', 'injected', 'responded', 'withdrawn', 'edited', 'reprioritized', 'invalidated', 'delivery-uncertain']],
  ] as const) if (!values.some(item => item === data[key])) throw new Error(`Invalid message ${key}`)
  if (data.reason !== undefined && !['target-closed-pending', 'target-archived', 'target-not-found', 'target-ambiguous', 'receive-disabled', 'handoff-only', 'cross-node-unsupported', 'claimed', 'injected', 'revision-conflict', 'operation-conflict', 'unauthorized', 'invalid-content', 'invalid-priority', 'invalid-reply', 'message-not-found', 'terminal-state', 'unavailable', 'delivery-uncertain', 'unsupported', 'interjection', 'record-corrupt'].some(reason => reason === data.reason)) throw new Error('Invalid message reason')
  if (data.firstRequestId !== undefined) strings(data, ['firstRequestId'])
  if (data.firstTurnId !== undefined && (!Number.isSafeInteger(data.firstTurnId) || Number(data.firstTurnId) < 0)) throw new Error('Invalid message turn')
  if (data.pending !== undefined && typeof data.pending !== 'boolean') throw new Error('Invalid message pending flag')
  if (data.deliveryOutcome !== undefined && !['accepted', 'rejected'].some(outcome => outcome === data.deliveryOutcome)) throw new Error('Invalid message delivery outcome')
  if (event.eventId !== messageEventId(value as Extract<MessageLedgerEvent, { kind: 'message/state' }>)) throw new Error('Invalid stable message event identity')
}

/** Message scan diagnostics are independent of the call journal. */
export interface MessageLedgerScan {
  events: MessageLedgerEvent[]
  complete: boolean
  corrupt: string[]
  tails: string[]
}

/** Read only a message node's segments, retaining incomplete and conflicting evidence.
 * @param root - Message node directory, outside ledger/v1.
 * @param maxRecordBytes - Maximum encoded record size.
 * @returns Valid unique facts and explicit integrity diagnostics.
 */
export async function recoverMessageSegments(root: string, maxRecordBytes: number): Promise<MessageLedgerScan> {
  const events = new Map<string, MessageLedgerEvent>()
  const versions = new Map<string, MessageLedgerEvent>()
  const corrupt: string[] = []
  const tails: string[] = []
  for (const path of await files(join(root, 'events'))) {
    const content = await readFile(path)
    for (const line of completeLines(content)) {
      try {
        const value = decode(line, maxRecordBytes)
        assertMessageEvent(value)
        const key = value.kind === 'message/state'
          ? canonicalJson([value.nodeId, value.data.messageId, value.data.stateVersion]) : value.eventId
        const prior = events.get(value.eventId) ?? versions.get(key)
        if (prior && canonicalJson(prior) !== canonicalJson(value)) throw new Error('Conflicting message state version')
        events.set(value.eventId, value)
        versions.set(key, value)
      } catch (error) {
        if (!(error instanceof Error)) throw error
        corrupt.push(path)
      }
    }
    if (content.length > 0 && content.at(-1) !== 10) tails.push(path)
  }
  return { events: [...events.values()], complete: !corrupt.length && !tails.length, corrupt, tails }
}

/** Commit one message state under the native writer lock; unequal replays reject without mutation.
 * @param root - Separate message node directory.
 * @param event - Body-free runtime fact with its derived stable event identity.
 * @param options - Native lock and encoded record limits.
 * @returns Stable acknowledgement cursor after file and directory fsync.
 */
export async function appendMessageUnique(root: string, event: MessageLedgerEvent, options: JournalOptions): Promise<MessageCursor> {
  const immutable: unknown = JSON.parse(canonicalJson(event))
  assertMessageEvent(immutable)
  const encoded = frame(immutable, options.maxRecordBytes)
  await ensureDirectory(root)
  return withWriterLock(join(root, 'writer.lock'), options, async () => {
    const scan = await recoverMessageSegments(root, options.maxRecordBytes)
    if (scan.corrupt.length) throw new Error('Message ledger corruption prevents further writes')
    const prior = scan.events.find(item => item.eventId === immutable.eventId
      || item.kind === 'message/state' && immutable.kind === 'message/state'
      && item.nodeId === immutable.nodeId && item.data.messageId === immutable.data.messageId
      && item.data.stateVersion === immutable.data.stateVersion)
    if (prior && canonicalJson(prior) !== canonicalJson(immutable)) throw new Error('Conflicting message state version')
    await syncFiles(await files(join(root, 'events')))
    if (!prior) {
      const directory = join(root, 'events', new Date().toISOString().slice(0, 10))
      await ensureDirectory(directory)
      // Never append after an interrupted tail: every committed fact owns a fresh segment.
      await durableFile(join(directory, `${randomUUID()}.jsonl`), encoded)
    }
    return immutable.eventId as string as MessageCursor
  })
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
      records.push({ type: 'fragment', input, path: ledgerRelative(root, path) })
    } else {
      record(value.reference)
      records.push(value as ArtifactRecord)
    }
  }
  const fragments = records.filter(item => item.type === 'fragment').sort((a, b) => a.input.seq - b.input.seq)
  const last = fragments.at(-1)
  for (const item of records) {
    if (item.type === 'closed' && (!last
      || referenceKey(item.reference) !== referenceKey(referenceOf(last.input, last.path)))) {
      throw new Error('Artifact closure does not reference the final durable fragment')
    }
  }
  return records
}

/** Reject fragments beyond a sealed stream before exposing ledger projections or imports.
 * @param root - Node directory containing call-owned artifact streams.
 * @param maxBytes - Maximum accepted encoded record size.
 * @param closures - View-owned decoded closure cache; absent callers read every closure.
 * @param callIds - Only these calls are checked when supplied; absent callers scan all artifact directories.
 */
export async function validateArtifactClosures(root: string, maxBytes: number,
  closures?: Map<string, { identity: string; seq: number | undefined }>,
  callIds?: ReadonlySet<string>,
): Promise<void> {
  if (callIds !== undefined) {
    for (const callId of callIds) {
      const directory = join(root, 'artifacts', digest(callId))
      let call
      try { call = await lstat(directory) }
      catch (error) { if (isCode(error, 'ENOENT')) continue; throw error }
      if (!call.isDirectory() || call.isSymbolicLink()) throw new Error('Invalid artifact directory')
      await validateCallArtifactClosures(directory, maxBytes, closures)
    }
    return
  }
  let calls
  try { calls = await readdir(join(root, 'artifacts'), { withFileTypes: true }) }
  catch (error) { if (isCode(error, 'ENOENT')) return; throw error }
  for (const call of calls) {
    if (!call.isDirectory() || call.isSymbolicLink()) throw new Error('Invalid artifact directory')
    await validateCallArtifactClosures(join(root, 'artifacts', call.name), maxBytes, closures)
  }
}

async function validateCallArtifactClosures(directory: string, maxBytes: number,
  closures?: Map<string, { identity: string; seq: number | undefined }>,
): Promise<void> {
  for (const kind of await readdir(directory)) {
    const stream = join(directory, kind)
    const entries = await readdir(stream, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('closed-')) continue
      const path = join(stream, entry.name)
      const info = closures === undefined ? undefined : await stat(path, { bigint: true })
      const identity = info === undefined ? '' : `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
      let closure = closures?.get(path)
      if (closure === undefined || closure.identity !== identity) {
        const bytes = await readFile(path)
        const end = bytes.indexOf(10)
        let seq: number | undefined
        if (end >= 0) {
          if (end !== bytes.length - 1) throw new Error('Invalid artifact segment framing')
          const value = record(decode(bytes.subarray(0, end), maxBytes))
          const reference = record(value.reference)
          if (value.type !== 'closed' || !Number.isSafeInteger(reference.seq)) throw new Error('Invalid artifact closure')
          seq = Number(reference.seq)
        }
        closure = { identity, seq }
        closures?.set(path, closure)
      }
      const seq = closure.seq
      if (seq !== undefined && entries.some(item => item.isDirectory() && Number(item.name) > seq)) {
        throw new Error('Artifact closure does not reference the final durable fragment')
      }
    }
  }
}

/** Instance-owned append hints; durable stream records remain authoritative. */
export class ArtifactAppendCache {
  /** Stream positions are scoped by absolute node path and artifact identity. */
  readonly streams = new Map<string, { next: number; closed: boolean }>()
}

async function sequenceDirectoryExists(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid artifact sequence directory')
    return true
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false
    throw error
  }
}

function referenceOf(input: LedgerArtifactAppend, path: string): LedgerArtifactReference {
  return { callId: input.callId, kind: input.kind, seq: input.seq, path, digest: digest(input.content) }
}

function referenceKey(reference: LedgerArtifactReference): string {
  // Legacy Windows separators are equivalent only for comparison, never rewritten on disk.
  return canonicalJson({ ...reference, path: reference.path.replaceAll('\\', '/') })
}

/** Append exact serialized JSON bytes to a contiguous call-owned sidecar stream.
 * @param root - Node directory owning the stream.
 * @param input - Fragment identity and unmodified serialized content.
 * @param options - Native lock and record size limits.
 * @param cache - Optional instance-owned hints; absent hints require a full initial scan on each call.
 * @param validateStart - Provider start guard inside the lock; absent for standalone fragment storage.
 * @returns Durable reference or an explicit conflicting digest pair.
 */
export async function appendArtifact(
  root: string, input: LedgerArtifactAppend, options: JournalOptions, cache?: ArtifactAppendCache,
  validateStart?: (index: LedgerIndex) => void,
): Promise<LedgerArtifactAppendResult> {
  if (!Number.isSafeInteger(input.seq) || input.seq < 0 || !['partial-response', 'keepalive-request'].includes(input.kind)) throw new Error('Invalid artifact key')
  JSON.parse(input.content)
  if (Buffer.from(input.content).toString('utf8') !== input.content) throw new Error('Artifact content must be lossless UTF-8')
  const encoded = frame({ type: 'fragment', input }, options.maxRecordBytes)
  await ensureDirectory(root)
  root = await realpath(root)
  return withWriterLock(join(root, 'writer.lock'), options, async () => {
    if (validateStart) {
      const view = await JournalView.forRoot(root, options)
      await view.refresh(root, options.maxRecordBytes)
      view.assertWritable()
      validateStart(view.index)
    }
    const relative = artifactPath(input)
    const stream = join(root, relative)
    const hint = cache?.streams.get(stream)
    const directory = join(stream, String(input.seq))
    const current = await sequenceDirectoryExists(directory)
    const previous = input.seq === 0 || await sequenceDirectoryExists(join(stream, String(input.seq - 1)))
    const sequential = hint !== undefined && !hint.closed && hint.next === input.seq && !current && previous
    const retry = hint !== undefined && current
    let fullScan = !sequential && !retry
    let records = sequential ? [] : await artifactRecords(root, retry ? `${relative}/${input.seq}` : relative, options.maxRecordBytes)
    if (retry && !records.some(item => item.type === 'fragment' && item.input.seq === input.seq)) {
      records = await artifactRecords(root, relative, options.maxRecordBytes)
      fullScan = true
    }
    if (fullScan) cache?.streams.set(stream, {
      next: records.filter(item => item.type === 'fragment').length,
      closed: records.some(item => item.type === 'closed'),
    })
    const fragments = records.filter(item => item.type === 'fragment')
      .sort((a, b) => a.input.seq - b.input.seq)
    const prior = fragments.find(item => item.input.seq === input.seq)
    if (prior) {
      if (prior.input.content !== input.content) return {
        kind: 'conflict', key: { callId: input.callId, kind: input.kind, seq: input.seq },
        existingDigest: digest(prior.input.content), incomingDigest: digest(input.content),
      }
      await syncFiles(await files(directory))
      return { kind: 'existing', reference: referenceOf(prior.input, prior.path) }
    }
    if (records.some(item => item.type === 'closed')) throw new Error('Artifact stream is already closed')
    if (!sequential && (fragments.some((item, seq) => item.input.seq !== seq) || input.seq !== fragments.length)) {
      throw new Error('Artifact sequence must be contiguous')
    }
    await ensureDirectory(directory)
    const path = `${relative}/${input.seq}/${ledgerUuid()}.jsonl`
    await durableFile(join(root, path), encoded)
    cache?.streams.set(stream, { next: input.seq + 1, closed: false })
    return { kind: 'appended', reference: referenceOf(input, path) }
  })
}

/** Durably seal a stream after validating its final persisted fragment.
 * Legacy separators compare equally; existing records stay unchanged and new closures use forward slashes.
 * @param root - Owning node directory.
 * @param reference - Exact last-fragment reference returned by appendArtifact.
 * @param options - Native lock and record size limits.
 * @param cache - Optional instance-owned hints updated on closure; absent hints retain no local state.
 * @returns Idempotent closure acknowledgement after fsync.
 */
export async function finishArtifact(
  root: string, reference: LedgerArtifactReference, options: JournalOptions, cache?: ArtifactAppendCache,
): Promise<LedgerArtifactFinishResult> {
  await ensureDirectory(root)
  root = await realpath(root)
  return withWriterLock(join(root, 'writer.lock'), options, async () => {
    const relative = artifactPath(reference)
    const records = await artifactRecords(root, relative, options.maxRecordBytes)
    const fragments = records.filter(item => item.type === 'fragment')
      .sort((a, b) => a.input.seq - b.input.seq)
    const last = fragments.at(-1)
    if (!last || fragments.some((item, seq) => item.input.seq !== seq)
      || referenceKey(referenceOf(last.input, last.path)) !== referenceKey(reference)) {
      throw new Error('Artifact closure does not reference the final durable fragment')
    }
    const closed = records.find(item => item.type === 'closed')
    if (closed) {
      if (referenceKey(closed.reference) !== referenceKey(reference)) throw new Error('Conflicting artifact closure')
      await syncFiles(await files(join(root, relative)))
      cache?.streams.set(join(root, relative), { next: fragments.length, closed: true })
      return { kind: 'existing', reference }
    }
    await syncFiles(await files(join(root, relative)))
    const durableReference = referenceOf(last.input, last.path)
    await durableFile(join(root, relative, `closed-${ledgerUuid()}.jsonl`), frame({ type: 'closed', reference: durableReference }, options.maxRecordBytes))
    cache?.streams.set(join(root, relative), { next: fragments.length, closed: true })
    return { kind: 'finished', reference: durableReference }
  })
}
