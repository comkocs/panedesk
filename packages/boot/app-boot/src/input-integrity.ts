/** Host-owned identities and trusted bytes for executable inputs inside a writable workspace. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { userInfo } from 'node:os'
import { setImmediate } from 'node:timers/promises'
import { InputReviewThread, runInputReviewThread, type InputReviewProgress } from './input-review-thread.ts'
import { assertWindowsStateTrusted } from '@panedesk/dsh-sandbox-windows-acl'
import { authoritativeHomeTrees, isHomeDiagnosticFile, protectedWorkspaceBranches } from '@panedesk/dsh-sandbox'
import { en, zh } from './input-integrity-locales.ts'
import { checkAuthoritativeTree } from './input-integrity-structure.ts'

/** Windows policy refuses workspace writes that include owner-state storage. */
export class WorkspaceContainsStateError extends Error {
  constructor() {
    super('The workspace contains the Panedesk state directory; choose one of its subdirectories. / 工作区包含 Panedesk 状态目录，请选它的子目录。 Protected input records must be outside the writable workspace.')
    this.name = 'WorkspaceContainsStateError'
  }
}

/** Admission refusal with shared localized diagnostics and an explicit recovery action. */
export class ProtectedInputReviewError extends Error {
  constructor() {
    super(`${en.reviewFailed} / ${zh.reviewFailed}`)
    this.name = 'ProtectedInputReviewError'
  }
}

/** Exact candidate shown to an owner before a protected input can change. */
export interface ProtectedInputChange {
  readonly path: string
  readonly previous: string
  readonly current: string
}

/** Approval and notification belong to the interactive host, never to filesystem watchers. */
export interface ProtectedInputOwner {
  /** Return true only for authenticated owner consent to this exact candidate. */
  confirm(change: ProtectedInputChange): Promise<boolean>
  /** Report a blocked candidate even when no interactive owner is available. */
  blocked(change: ProtectedInputChange): void
}

/** Structured-cloned reader data exchanged only with the host-owned review isolate. */
export interface InputReviewState {
  workspace: string
  home?: string
  revision?: string
  stamp?: string
  approved: [string, InputSnapshot][]
  observed: string[]
  granted: boolean
  owners: InputReviewState[]
  verifiedPass?: { pass: CapturePass; roots: ReadonlySet<string> }
}

interface InputSnapshot {
  digest: string
  treeDigest?: string
  kind: 'missing' | 'file' | 'directory' | 'link' | 'other'
  target: string | null
  content: string | null
  blob?: string
  ancestors?: readonly { path: string; mode: number }[]
  files?: readonly { path: string; content?: string; blob?: string }[]
}

function contains(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function canonicalLocation(path: string): string {
  try { return realpathSync(path) } catch (error) {
    if (!missing(error)) throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(canonicalLocation(parent), relative(parent, path))
  }
}

function identity(path: string, ancestor = false, legacy = false): string {
  try {
    const stat = lstatSync(path, { bigint: true })
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${ancestor ? stat.mode & ~0o777n : stat.mode}:${stat.isSymbolicLink() ? realpathSync(path) : ''}${legacy ? '' : `:${stat.uid}:${stat.gid}`}`
  } catch (error) {
    if (missing(error)) return 'missing'
    throw error
  }
}

function treeStamp(path: string): string {
  try {
    const link = lstatSync(path, { bigint: true })
    const target = statSync(path, { bigint: true })
    return [realpathSync.native(path), ...[link, target].map(stat =>
      `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.nlink}`)].join('\0')
  } catch (error) {
    if (missing(error)) return 'missing'
    throw error
  }
}

interface CapturePass {
  recordedAt: number
  identities: Map<string, string>
  stamps: Map<string, string>
  nodes: Map<string, { identity: string; kind: 'file' | 'directory' | 'other' | 'missing'; target: string }>
  directories: Map<string, readonly string[]>
  bytes: Map<string, { chunks?: readonly Buffer[]; blob: string }>
  previous?: CapturePass
  diagnostics: Map<string, string>
  authorityRoots: Set<string>
}

function capturePass(): CapturePass {
  return {
    recordedAt: Date.now(), identities: new Map(), stamps: new Map(), nodes: new Map(),
    directories: new Map(), bytes: new Map(), diagnostics: new Map(), authorityRoots: new Set(),
  }
}

function* contentDigest(filename: string): Generator<void, string> {
  const descriptor = openSync(filename, 'r')
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(64 * 1024)
  try {
    let length: number
    while ((length = readSync(descriptor, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, length))
      yield
    }
    return hash.digest('hex')
  } finally { closeSync(descriptor) }
}

function* unchangedEntry(pass: CapturePass, filename: string): Generator<void, boolean> {
  if (identity(filename) !== pass.identities.get(filename)) return false
  const target = canonicalLocation(filename)
  const bytes = pass.bytes.get(target)
  if (bytes !== undefined && (yield* contentDigest(filename)) !== bytes.blob) return false
  const names = pass.directories.get(target)
  return names === undefined || JSON.stringify(readdirSync(target).sort().filter(name => !pass.authorityRoots.has(join(target, name))))
    === JSON.stringify(names.filter(name => !pass.authorityRoots.has(join(target, name))))
}

function* checkPass(pass: CapturePass): Generator<void, void> {
  for (const root of pass.authorityRoots) yield* checkAuthoritativeTree(root)
  for (const [filename, home] of pass.diagnostics) {
    if (!isHomeDiagnosticFile(home, filename)) throw new Error(`Protected host diagnostic changed type while being read: ${filename}`)
  }
  for (const [filename, before] of pass.stamps) {
    yield
    const after = treeStamp(filename)
    if (after === before) continue
    if (! (yield* unchangedEntry(pass, filename))) throw new Error(`Protected host input changed while being read: ${filename}`)
    pass.stamps.set(filename, after)
  }
}

function recentStamp(stamp: string, recordedAt: number): boolean {
  // Two seconds conservatively covers coarse filesystem timestamp granularity.
  const cutoff = BigInt(Math.trunc(recordedAt - 2000)) * 1_000_000n
  return stamp.split('\0').slice(1).some(value => value.split(':').slice(4, 6).some(time => BigInt(time) >= cutoff))
}

function reusableEntry(pass: CapturePass, previous: CapturePass, filename: string): boolean {
  if (process.platform !== 'linux' && process.platform !== 'win32') return false
  const before = previous.stamps.get(filename)
  return before !== undefined && before === pass.stamps.get(filename)
    && previous.identities.get(filename) === pass.identities.get(filename)
    && !recentStamp(before, previous.recordedAt)
}

function* reusablePass(pass: CapturePass): Generator<void, boolean> {
  // macOS ctime mutability is unverified: retain full reads there. Windows relies
  // on protected inputs remaining unwritable by the sandbox; ChangeTime is mutable.
  if (process.platform !== 'linux' && process.platform !== 'win32') return false
  const recordedAt = Date.now()
  for (const [filename, home] of pass.diagnostics) {
    if (!isHomeDiagnosticFile(home, filename)) return false
  }
  for (const [filename, before] of pass.stamps) {
    yield
    const after = treeStamp(filename)
    if (after !== before || recentStamp(before, pass.recordedAt)) {
      if (! (yield* unchangedEntry(pass, filename))) return false
    }
  }
  yield* checkPass(pass)
  // Age metadata from before the first read, not after a potentially long pass.
  pass.recordedAt = recordedAt
  return true
}

function finishSync<T>(operation: Generator<void, T>): T {
  let next = operation.next()
  while (!next.done) next = operation.next()
  return next.value
}

async function finishAsync<T>(operation: Generator<void, T>, progress?: () => void, current?: () => void): Promise<T> {
  await setImmediate()
  current?.()
  let deadline = performance.now() + 8
  let next = operation.next()
  while (!next.done) {
    if (performance.now() >= deadline) {
      progress?.()
      await setImmediate()
      current?.()
      deadline = performance.now() + 8
    }
    next = operation.next()
  }
  current?.()
  return next.value
}

function* snapshot(
  path: string, root: string, files?: Map<string, Buffer>, pass = capturePass(), excluded?: string,
  blobs?: string, selected?: string, legacy = false, diagnosticHome?: string,
): Generator<void, InputSnapshot> {
  const { stamps } = pass
  const authorityRoots = diagnosticHome === undefined ? [] : authoritativeHomeTrees(diagnosticHome)
  for (const tree of authorityRoots) pass.authorityRoots.add(tree)
  const hash = createHash('sha256')
  const copies: { path: string; content?: string; blob?: string }[] = []
  const ancestors: { path: string; mode: number }[] = []
  const chunk = Buffer.allocUnsafe(64 * 1024)
  if (blobs !== undefined) mkdirSync(blobs, { recursive: true, mode: 0o700 })
  const capture = (filename: string): void => {
    if (!stamps.has(filename)) {
      stamps.set(filename, treeStamp(filename))
      pass.identities.set(filename, identity(filename))
    }
  }
  for (let current = path; contains(root, current); current = dirname(current)) {
    capture(current)
    const ancestor = !legacy && current !== path
    hash.update(current).update('\0').update(identity(current, ancestor, legacy)).update('\0')
    if (ancestor) {
      try { ancestors.push({ path: current, mode: Number(lstatSync(current, { bigint: true }).mode) }) } catch (error) {
        if (!missing(error)) throw error
      }
    }
    if (current === dirname(current)) break
  }
  const visited = new Set<string>()
  const walk = function* (filename: string, logicalFilename = filename): Generator<void, void> {
    yield
    if (filename === logicalFilename && authorityRoots.includes(filename)) return
    if (excluded !== undefined && contains(excluded, canonicalLocation(filename))) return
    if (diagnosticHome !== undefined && filename === logicalFilename && isHomeDiagnosticFile(diagnosticHome, filename)) {
      pass.diagnostics.set(filename, diagnosticHome)
      return
    }
    capture(filename)
    const key = `${legacy ? 'legacy' : 'current'}\0${filename}`
    let node = pass.nodes.get(key)
    if (node === undefined) {
      const value = identity(filename, false, legacy)
      try {
        const stat = statSync(filename)
        node = { identity: value, kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other', target: realpathSync(filename) }
      } catch (error) {
        if (!missing(error)) throw error
        node = { identity: value, kind: 'missing', target: filename }
      }
      pass.nodes.set(key, node)
    }
    hash.update(logicalFilename).update('\0').update(node.identity).update('\0')
    if (node.kind === 'file') {
      const canonical = node.target
      let cached = pass.bytes.get(canonical)
      const previous = pass.previous
      if (cached === undefined && previous !== undefined && reusableEntry(pass, previous, filename)) {
        cached = previous.bytes.get(canonical)
        if (cached !== undefined) pass.bytes.set(canonical, cached)
      }
      if (cached !== undefined) {
        const retain = files !== undefined && (selected === undefined || logicalFilename === selected)
        const retained: Buffer[] = []
        if (cached.chunks !== undefined) {
          for (const bytes of cached.chunks) { hash.update(bytes); yield }
          retained.push(...cached.chunks)
        } else {
          if (blobs === undefined) throw new Error('Protected input capture has no content storage')
          const descriptor = openSync(join(blobs, cached.blob), 'r')
          const digest = createHash('sha256')
          try {
            let length: number
            while ((length = readSync(descriptor, chunk, 0, chunk.length, null)) > 0) {
              const bytes = chunk.subarray(0, length)
              hash.update(bytes)
              digest.update(bytes)
              if (retain) retained.push(Buffer.from(bytes))
              yield
            }
            if (digest.digest('hex') !== cached.blob) throw new Error('Protected input copy changed during capture')
          } finally { closeSync(descriptor) }
        }
        hash.update('\0')
        if (blobs === undefined) copies.push({ path: logicalFilename, content: Buffer.concat(retained).toString('base64') })
        else copies.push({ path: logicalFilename, blob: cached.blob })
        if (retain) files.set(logicalFilename, Buffer.concat(retained))
        return
      }
      const descriptor = openSync(filename, 'r')
      const temporary = blobs === undefined ? undefined : join(blobs, `${randomUUID()}.new`)
      let output: number | undefined
      try {
        if (temporary !== undefined) output = openSync(temporary, 'wx', 0o600)
        const before = fstatSync(descriptor, { bigint: true })
        const digest = createHash('sha256')
        const retained: Buffer[] = []
        let length: number
        while ((length = readSync(descriptor, chunk, 0, chunk.length, null)) > 0) {
          const bytes = chunk.subarray(0, length)
          hash.update(bytes)
          digest.update(bytes)
          if (blobs === undefined || files !== undefined && (selected === undefined || logicalFilename === selected)) {
            retained.push(Buffer.from(bytes))
          }
          if (output !== undefined) {
            let offset = 0
            while (offset < length) offset += writeSync(output, bytes, offset, length - offset)
          }
          yield
        }
        const after = fstatSync(descriptor, { bigint: true })
        const blob = digest.digest('hex')
        if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.size !== after.size
          || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.nlink !== after.nlink) {
          if (before.mode !== after.mode || (yield* contentDigest(filename)) !== blob) {
            throw new Error(`Protected host input changed while being read: ${filename}`)
          }
        }
        hash.update('\0')
        pass.bytes.set(canonical, { ...blobs === undefined ? { chunks: retained } : {}, blob })
        if (output !== undefined) { closeSync(output); output = undefined }
        if (temporary !== undefined && blobs !== undefined) {
          const destination = join(blobs, blob)
          if (existsSync(destination)) unlinkSync(temporary)
          else renameSync(temporary, destination)
          copies.push({ path: logicalFilename, blob })
        } else copies.push({ path: logicalFilename, content: Buffer.concat(retained).toString('base64') })
        if (files !== undefined && (selected === undefined || logicalFilename === selected)) {
          files.set(logicalFilename, Buffer.concat(retained))
        }
      } finally {
        closeSync(descriptor)
        if (output !== undefined) closeSync(output)
        if (temporary !== undefined) {
          try { unlinkSync(temporary) } catch (error) { if (!missing(error)) throw error }
        }
      }
      return
    }
    if (node.kind === 'directory') {
      const target = node.target
      if (visited.has(target)) return
      visited.add(target)
      let names = pass.directories.get(target)
      const previous = pass.previous
      if (names === undefined && previous !== undefined && reusableEntry(pass, previous, filename)) {
        names = previous.directories.get(target)
      }
      if (names === undefined) names = readdirSync(target).sort()
      pass.directories.set(target, names)
      // Each logical root retains its own cycle order and path spelling.
      for (const name of names) yield* walk(join(target, name), join(logicalFilename, name))
    }
  }
  let kind: InputSnapshot['kind'] = 'missing'
  let target: string | null = null
  try {
    const stat = lstatSync(path)
    kind = stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other'
    target = realpathSync(path)
  } catch (error) {
    if (!missing(error)) throw error
  }
  yield* walk(path)
  const direct = copies.find(file => file.path === path)
  const treeDigest = hash.digest('hex')
  const digest = legacy ? treeDigest : createHash('sha256').update(treeDigest).update(JSON.stringify(ancestors)).digest('hex')
  return { digest, ...legacy ? {} : { treeDigest }, kind, target, content: direct?.content ?? null,
    ...(direct?.blob === undefined ? {} : { blob: direct.blob }),
    ...legacy ? {} : { ancestors }, files: copies }
}

function matches(previous: InputSnapshot, current: InputSnapshot): boolean {
  if ((previous.treeDigest ?? previous.digest) !== (current.treeDigest ?? current.digest)) return false
  return previous.ancestors === undefined || previous.ancestors.every((before) => {
    const after = current.ancestors?.find(item => item.path === before.path)
    // Only removing group/other permissions is an automatic tightening.
    return after !== undefined && (after.mode & ~0o077) === (before.mode & ~0o077)
      && (after.mode & 0o077 & ~before.mode) === 0
  })
}

function parseSnapshot(value: unknown): InputSnapshot {
  return finishSync(restoreSnapshot(value))
}

function* restoreSnapshot(value: unknown): Generator<void, InputSnapshot> {
  if (typeof value !== 'object' || value === null || !('digest' in value) || typeof value.digest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.digest) || !('kind' in value)
    || !('target' in value) || !(value.target === null || typeof value.target === 'string')
    || !('content' in value) || !(value.content === null || typeof value.content === 'string')) {
    throw new Error('Invalid protected host input record')
  }
  const kind = value.kind
  if (kind !== 'missing' && kind !== 'file' && kind !== 'directory' && kind !== 'link' && kind !== 'other') {
    throw new Error('Invalid protected host input type')
  }
  const treeDigest = 'treeDigest' in value ? value.treeDigest : undefined
  if (treeDigest !== undefined && (typeof treeDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(treeDigest))) {
    throw new Error('Invalid protected input tree digest')
  }
  const blob = 'blob' in value ? value.blob : undefined
  if (blob !== undefined && (typeof blob !== 'string' || !/^[a-f0-9]{64}$/u.test(blob))) {
    throw new Error('Invalid protected input blob')
  }
  const ancestors: { path: string; mode: number }[] = []
  if ('ancestors' in value) {
    if (!Array.isArray(value.ancestors)) throw new Error('Invalid protected input ancestors')
    const entries: unknown[] = value.ancestors
    for (const item of entries) {
      if (typeof item !== 'object' || item === null || !('path' in item) || typeof item.path !== 'string'
        || !('mode' in item) || typeof item.mode !== 'number' || !Number.isSafeInteger(item.mode)) {
        throw new Error('Invalid protected input ancestor')
      }
      ancestors.push({ path: item.path, mode: item.mode })
      yield
    }
  }
  const files: { path: string; content?: string; blob?: string }[] = []
  if ('files' in value) {
    if (!Array.isArray(value.files)) throw new Error('Invalid protected input copies')
    const entries: unknown[] = value.files
    for (const file of entries) {
      if (typeof file !== 'object' || file === null || !('path' in file) || typeof file.path !== 'string') {
        throw new Error('Invalid protected input copy')
      }
      if ('blob' in file && typeof file.blob === 'string' && /^[a-f0-9]{64}$/u.test(file.blob)) {
        files.push({ path: file.path, blob: file.blob })
      } else if ('content' in file && typeof file.content === 'string') {
        files.push({ path: file.path, content: file.content })
      } else throw new Error('Invalid protected input copy')
      yield
    }
  }
  return { digest: value.digest, kind, target: value.target, content: value.content,
    ...treeDigest === undefined ? {} : { treeDigest },
    ...blob === undefined ? {} : { blob },
    ...'ancestors' in value ? { ancestors } : {},
    ...'files' in value ? { files } : {},
  }
}

/** A workspace's owner-approved input set; rejected reads never replace its baseline. */
export class ProtectedInputIntegrity {
  private approved = new Map<string, InputSnapshot>()
  private readonly observed = new Set<string>()
  private readonly root: string
  private readonly workspace: string
  private record: string | undefined
  private home: string | undefined
  private workspaceIdentity: string
  private granted: boolean
  private revision: string | undefined
  private verifying = false
  private reviews: Promise<void> = Promise.resolve()
  private readonly activeReviews = new Set<Promise<boolean>>()
  private grant: { promise: Promise<void>; pending: boolean; failed: boolean } | undefined
  private stateFailure: Error | undefined
  private verifiedPass: { pass: CapturePass; roots: ReadonlySet<string> } | undefined
  private admission: { promise: Promise<void>; enrolling: boolean; roots: number } | undefined
  private rootsVersion = 0
  private generation = 0
  private reviewCommit: ((prepared: object) => Promise<string | undefined>) | undefined
  private reviewPrepare: ((prepared: object) => Promise<void>) | undefined
  private readonly reviewThread = new InputReviewThread()
  private reviewCacheKey: string | undefined
  private reviewWorkerIdentity: string | undefined

  /** Release the process-local checked pass and await the owned review child.
   * @returns Completion of isolate termination; future reviews import fresh state.
   */
  async disposeReview(): Promise<void> {
    this.generation++
    await this.resetReview()
    await Promise.allSettled([...this.activeReviews, this.reviews])
  }

  private async resetReview(): Promise<void> {
    this.reviewCacheKey = undefined
    this.verifiedPass = undefined
    await this.reviewThread.dispose()
  }

  /** Identify the exact in-memory authority sent over the private review channel.
   * @returns Small metadata only; no approved copies or checked file stamps.
   */
  reviewIdentity(): string {
    return createHash('sha256').update(JSON.stringify([this.workspaceIdentity, this.generation, this.rootsVersion, this.revision,
      this.granted, [...this.observed], this.ownerRecords.map(record => record.reviewIdentity())])).digest('hex')
  }

  /** Revoke pending captures and reviews without changing the durable record format.
   * @param workspace Canonical workspace whose owner authority changed.
   */
  invalidateWorkspace(workspace: string): void {
    for (const record of this.ownerRecords) record.invalidateWorkspace(workspace)
    if (canonicalLocation(workspace) !== this.root) return
    this.generation++
    this.admission = undefined
    this.grant = undefined
    this.verifiedPass = undefined
  }

  private checkpoint(): () => void {
    const generation = this.generation
    const roots = this.rootsVersion
    return () => {
      if (generation !== this.generation) throw new Error('Protected workspace generation was revoked or replaced')
      if (roots !== this.rootsVersion) throw new Error('Protected host input registered during capture')
    }
  }

  /** Delegate isolated baseline commits to the supervising host, which owns revocation.
   * @param commit Host commit request; the isolate never renames a trusted baseline itself.
   * @param prepare Host-owned lock acquisition and temporary-file cleanup for isolated writers.
   */
  setReviewCommit(commit: (prepared: object) => Promise<string | undefined>, prepare?: (prepared: object) => Promise<void>): void {
    this.reviewCommit = commit
    this.reviewPrepare = prepare
    for (const record of this.ownerRecords) record.setReviewCommit(commit, prepare)
  }

  private stateTrusted(): boolean {
    if (this.record === undefined || process.platform !== 'win32') return true
    try { assertWindowsStateTrusted(this.record, this.root) } catch (error) {
      if (!(error instanceof Error)) throw error
      this.stateFailure = error
      return false
    }
    this.stateFailure = undefined
    return true
  }
  private readonly ownerRecords: ProtectedInputIntegrity[] = []
  private recordView = false
  private loadedStamp: string | undefined
  private isolatedReview = false
  private reviewProgress: (message: string) => void = () => {}
  private reviewUnit: (() => void) | undefined

  /** Install worker-local completed-work reporting; no timer heartbeat counts as progress.
   * @param progress Called only after generator work advances.
   */
  setReviewProgress(progress: () => void): void {
    this.reviewUnit = progress
    for (const record of this.ownerRecords) record.setReviewProgress(progress)
  }
  private fileIndex = new Map<string, Map<string, { content?: string; blob?: string }>>()

  private indexCopies(): void {
    finishSync(this.restoreIndex())
  }

  private *restoreIndex(): Generator<void, void> {
    this.fileIndex.clear()
    for (const [root, value] of this.approved) {
      const index = new Map<string, { content?: string; blob?: string }>()
      for (const file of value.files ?? []) {
        if (!index.has(file.path)) index.set(file.path, file)
        yield
      }
      this.fileIndex.set(root, index)
      yield
    }
  }

  /**
   * Open every granted workspace for an owner before parsing any launch input.
   * @param workspace Launch workspace; opening it does not grant write access.
   * @param home Owner state root containing the durable workspace records.
   * @param progress Receives checked and total counts while overlapping records are compared; omission reports nothing.
   * @returns A reader that rejects inconsistent overlapping records instead of reading current files.
   */
  static openOwnerRecords(workspace: string, home: string, progress?: (value: InputReviewProgress) => void): ProtectedInputIntegrity {
    const reader = new ProtectedInputIntegrity(workspace, home)
    if (!reader.stateTrusted()) return reader
    const directory = join(resolve(home), 'windows-workspace-write', 'protected-inputs')
    let names: string[]
    try { names = readdirSync(directory) } catch (error) {
      if (missing(error)) return reader
      throw error
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const filename = join(directory, name)
      if (filename === reader.record) continue
      const before = treeStamp(filename)
      const text = readFileSync(filename, 'utf8')
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || !('workspace' in parsed)
        || typeof parsed.workspace !== 'string' || !isAbsolute(parsed.workspace)) {
        throw new Error('Invalid protected workspace record')
      }
      const record = new ProtectedInputIntegrity(parsed.workspace)
      record.home = canonicalLocation(home)
      record.workspaceIdentity = ProtectedInputIntegrity.workspaceKey(parsed.workspace, home)
      record.record = filename
      const expected = join(directory, `${createHash('sha256').update(record.root).digest('hex')}.json`)
      if (expected !== filename) throw new Error('Invalid protected workspace record location')
      record.loadRecord(text)
      record.loadedStamp = before
      if (!record.granted) throw new Error('Invalid protected workspace record location')
      if (record.root !== reader.root) reader.ownerRecords.push(record)
    }
    const records = [reader, ...reader.ownerRecords]
    const boundaries = records.map((record) => {
      record.assertRecordLocation()
      record.recordView = true
      return record.loadedStamp
    })
    try {
      const paths = new Set(records.flatMap(record => [...record.approved].flatMap(([path, value]) => [
        ...value.kind === 'file' || value.content !== null ? [path] : [],
        ...value.files?.map(file => file.path) ?? [],
      ])))
      let completed = 0
      progress?.({ completed, total: paths.size })
      for (const path of paths) {
        let approved: Buffer | undefined
        let found = false
        for (const record of records.filter(record => record.covers(path))) {
          const bytes = record.readTrusted(path)
          if (found && (approved === undefined ? bytes !== undefined : bytes === undefined || !approved.equals(bytes))) {
            throw new Error(`Conflicting protected host input records: ${path}`)
          }
          approved = bytes
          found = true
        }
        completed++
        if (completed % 64 === 0 || completed === paths.size) progress?.({ completed, total: paths.size })
      }
      for (const [index, record] of records.entries()) {
        record.assertRecordLocation()
        if (record.record !== undefined && treeStamp(record.record) !== boundaries[index]) {
          throw new Error('Protected workspace record changed during owner review')
        }
      }
    } finally {
      for (const record of records) record.recordView = false
    }
    return reader
  }

  /** Open owner records off-thread with a progress-based, independently scheduled watchdog.
   * @param workspace Launch workspace; no write access is granted.
   * @param home Protected owner storage; only its review configuration changes the stall interval.
   * @param progress Bilingual progress sink; omitted suppresses display, never supervision.
   * @returns A reader retaining the reviewed record generation, not a cross-process cache.
   */
  static async openOwnerRecordsAsync(
    workspace: string, home: string, progress: (message: string) => void = () => {},
  ): Promise<ProtectedInputIntegrity> {
    progress(`${en.starting} / ${zh.starting}`)
    const report = (value: InputReviewProgress): void => {
      progress(`${en.reviewProgress(value.completed, value.total)} / ${zh.reviewProgress(value.completed, value.total)}`)
    }
    const result = await runInputReviewThread({ kind: 'open', workspace, home }, report, () => Promise.resolve(false))
    const reader = ProtectedInputIntegrity.fromReviewState(result)
    reader.isolatedReview = true
    reader.reviewProgress = progress
    return reader
  }

  /** Export operation-local state for the owned isolate; never persists checked stamps.
   * @returns Structured-cloneable reader state.
   */
  exportReviewState(): InputReviewState {
    return { workspace: this.workspace, ...this.home === undefined ? {} : { home: this.home },
      ...this.revision === undefined ? {} : { revision: this.revision },
      ...this.loadedStamp === undefined ? {} : { stamp: this.loadedStamp },
      approved: [...this.approved], observed: [...this.observed], granted: this.granted,
      owners: this.ownerRecords.map(record => record.exportReviewState()),
      ...this.verifiedPass === undefined ? {} : { verifiedPass: this.verifiedPass } }
  }

  /** Restore host-owned worker output after validating its durable snapshot fields.
   * @param value Structured-cloned worker state; invalid messages fail closed.
   * @returns Reader for the exact reviewed generation, without rereading the durable record.
   */
  static fromReviewState(value: unknown): ProtectedInputIntegrity
  /** Restore in cooperative batches, keeping the reader private until all checks finish.
   * @param value Structured-cloned worker state; invalid messages fail closed.
   * @param current Validate the caller's authority after each yield and before returning.
   * @returns The complete reader; validation failures discard the unpublished state.
   */
  static fromReviewState(value: unknown, current: () => void): Promise<ProtectedInputIntegrity>
  static fromReviewState(value: unknown, current?: () => void): ProtectedInputIntegrity | Promise<ProtectedInputIntegrity> {
    const operation = ProtectedInputIntegrity.restoreReviewState(value)
    return current === undefined ? finishSync(operation) : finishAsync(operation, undefined, current)
  }

  private static *restoreReviewState(value: unknown): Generator<void, ProtectedInputIntegrity> {
    if (typeof value !== 'object' || value === null || !('workspace' in value) || typeof value.workspace !== 'string'
      || !('approved' in value) || !Array.isArray(value.approved) || !('observed' in value) || !Array.isArray(value.observed)
      || !('granted' in value) || typeof value.granted !== 'boolean' || !('owners' in value) || !Array.isArray(value.owners)
      || 'home' in value && typeof value.home !== 'string' || 'revision' in value && typeof value.revision !== 'string'
      || 'stamp' in value && typeof value.stamp !== 'string') throw new Error('Invalid protected input worker state')
    const reader = new ProtectedInputIntegrity(value.workspace)
    if ('home' in value && typeof value.home === 'string') {
      reader.home = value.home
      reader.workspaceIdentity = ProtectedInputIntegrity.workspaceKey(value.workspace, value.home)
      reader.record = join(resolve(value.home), 'windows-workspace-write', 'protected-inputs', `${createHash('sha256').update(reader.root).digest('hex')}.json`)
    }
    reader.assertRecordLocation()
    for (const item of value.approved) {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !contains(reader.root, item[0])) {
        throw new Error('Invalid protected input worker snapshot')
      }
      const path = item[0]
      const snapshot = yield* restoreSnapshot(item[1])
      for (const file of snapshot.files ?? []) {
        if (!isAbsolute(file.path) || !contains(path, file.path)) throw new Error('Invalid protected input copy path')
        yield
      }
      reader.approved.set(item[0], snapshot)
      yield
    }
    for (const path of value.observed) {
      if (typeof path !== 'string') throw new Error('Invalid protected input worker path')
      reader.observed.add(path)
      yield
    }
    reader.granted = value.granted
    reader.revision = 'revision' in value && typeof value.revision === 'string' ? value.revision : undefined
    reader.loadedStamp = 'stamp' in value && typeof value.stamp === 'string' ? value.stamp : undefined
    for (const owner of value.owners) {
      reader.ownerRecords.push(yield* ProtectedInputIntegrity.restoreReviewState(owner))
      yield
    }
    if ('verifiedPass' in value) {
      const checked = value.verifiedPass
      if (typeof checked !== 'object' || checked === null || !('pass' in checked) || typeof checked.pass !== 'object'
        || checked.pass === null || !('roots' in checked) || !(checked.roots instanceof Set)
        || !('stamps' in checked.pass) || !(checked.pass.stamps instanceof Map)
        || !('identities' in checked.pass) || !(checked.pass.identities instanceof Map)
        || !('nodes' in checked.pass) || !(checked.pass.nodes instanceof Map)
        || !('directories' in checked.pass) || !(checked.pass.directories instanceof Map)
        || !('bytes' in checked.pass) || !(checked.pass.bytes instanceof Map)
        || !('diagnostics' in checked.pass) || !(checked.pass.diagnostics instanceof Map)
        || !('authorityRoots' in checked.pass) || !(checked.pass.authorityRoots instanceof Set)
        || !('recordedAt' in checked.pass) || typeof checked.pass.recordedAt !== 'number') {
        throw new Error('Invalid protected input worker checked pass')
      }
      reader.verifiedPass = checked as { pass: CapturePass; roots: ReadonlySet<string> }
    }
    yield* reader.restoreIndex()
    return reader
  }

  /**
   * @param workspace Absolute writable workspace whose executable inputs require confirmation.
   * @param home Owner state root outside the workspace; omission retains process-local observation semantics.
   */
  constructor(workspace: string, home?: string) {
    this.workspace = resolve(workspace)
    this.root = canonicalLocation(this.workspace)
    this.workspaceIdentity = ProtectedInputIntegrity.workspaceKey(workspace, home)
    this.granted = home === undefined
    if (home === undefined) return
    this.home = canonicalLocation(home)
    const directory = join(resolve(home), 'windows-workspace-write', 'protected-inputs')
    this.record = join(directory, `${createHash('sha256').update(this.root).digest('hex')}.json`)
    if (!this.stateTrusted()) {
      console.warn(String(this.stateFailure))
      return
    }
    let text: string
    this.loadedStamp = treeStamp(this.record)
    try { text = readFileSync(this.record, 'utf8') } catch (error) {
      if (missing(error)) return
      throw error
    }
    this.loadRecord(text)
  }

  /**
   * Match the workspace and owner storage before reusing this reader for a write grant.
   * @param workspace Requested writable workspace, including canonical aliases.
   * @param home Owner storage for the requested grant; memory-only readers never match.
   * @returns Whether this reader owns the requested durable workspace record.
   */
  ownsWorkspaceRecord(workspace: string, home: string): boolean {
    return this.home !== undefined && this.workspaceIdentity === ProtectedInputIntegrity.workspaceKey(workspace, home)
  }

  /**
   * Identify a host-owned reader without merging owner domains or replaced workspace objects.
   * @param workspace Writable directory; canonical aliases share a slot.
   * @param home Durable owner storage; omission identifies a memory-only reader.
   * @returns Process-local identity; baseline revisions and observed roots remain reader-owned.
   */
  static workspaceKey(workspace: string, home?: string): string {
    const root = canonicalLocation(resolve(workspace))
    const owner = userInfo()
    return JSON.stringify([process.platform, owner.uid, owner.username, home === undefined ? null : canonicalLocation(home),
      root, identity(root, true), 'protected-input-v1'])
  }

  /**
   * Resolve the path index used by existing confinement consumers.
   * @param workspace Writable directory spelling.
   * @returns Canonical path, including a missing final component.
   */
  static workspacePath(workspace: string): string {
    return canonicalLocation(resolve(workspace))
  }

  private loadRecord(text: string, revision = createHash('sha256').update(text).digest('hex')): void {
    this.assertRecordLocation()
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1
      || !('workspace' in parsed) || parsed.workspace !== this.root || !('inputs' in parsed)
      || !Array.isArray(parsed.inputs)) throw new Error('Invalid protected workspace record')
    const inputs: unknown[] = parsed.inputs
    const approved = new Map<string, InputSnapshot>()
    for (const item of inputs) {
      if (typeof item !== 'object' || item === null || !('path' in item) || typeof item.path !== 'string'
        || !contains(this.root, item.path) || !('snapshot' in item)) throw new Error('Invalid protected input path')
      const path = item.path
      const value = parseSnapshot(item.snapshot)
      if (value.files?.some(file => !isAbsolute(file.path) || !contains(path, file.path)) === true) {
        throw new Error('Invalid protected input copy path')
      }
      approved.set(item.path, value)
    }
    this.verifiedPass = undefined
    this.approved.clear()
    for (const [path, value] of approved) {
      this.approved.set(path, value)
      this.observed.add(path)
    }
    this.indexCopies()
    this.revision = revision
    this.granted = true
  }

  private refreshRecord(): void {
    if (this.recordView) return
    if (this.record === undefined || this.verifying || this.grant?.pending === true
      || this.grant?.failed === true || !this.stateTrusted()) return
    if (this.revision !== undefined) this.assertRecordLocation()
    let text: string
    this.loadedStamp = treeStamp(this.record)
    try { text = readFileSync(this.record, 'utf8') } catch (error) {
      if (!missing(error)) throw error
      if (this.revision !== undefined) throw new Error('Protected workspace record disappeared')
      return
    }
    const revision = createHash('sha256').update(text).digest('hex')
    if (revision !== this.revision) this.loadRecord(text, revision)
  }

  private inputPath(filename: string): string {
    const path = resolve(filename)
    return contains(this.workspace, path) ? resolve(this.root, relative(this.workspace, path)) : path
  }

  private isRecordStorage(path: string): boolean {
    if (this.record === undefined) return false
    const storage = canonicalLocation(dirname(this.record))
    try { return contains(storage, canonicalLocation(path)) } catch (error) {
      // A cyclic input cannot resolve into record storage; coverage still checks its recorded spelling.
      if (error instanceof Error && 'code' in error && error.code === 'ELOOP') return false
      throw error
    }
  }

  private *capture(path: string, files?: Map<string, Buffer>, pass = capturePass(), selected?: string): Generator<void, InputSnapshot> {
    return yield* snapshot(path, this.root, files, pass,
      this.record === undefined ? undefined : canonicalLocation(dirname(this.record)),
      this.record === undefined ? undefined : join(dirname(this.record), 'blobs'), selected,
      this.approved.has(path) && this.approved.get(path)?.ancestors === undefined,
      this.home !== undefined && contains(path, this.home) ? this.home : undefined)
  }

  private readCopy(copy: { content?: string | null; blob?: string }): Buffer {
    if (copy.blob !== undefined && this.record !== undefined) {
      const bytes = readFileSync(join(dirname(this.record), 'blobs', copy.blob))
      if (createHash('sha256').update(bytes).digest('hex') !== copy.blob) {
        throw new Error('Protected input copy changed')
      }
      return bytes
    }
    if (typeof copy.content === 'string') return Buffer.from(copy.content, 'base64')
    throw new Error('Protected host input has no approved copy')
  }

  private assertRecordLocation(protectedPaths?: readonly string[]): void {
    if (this.record === undefined) return
    assertWindowsStateTrusted(this.record, this.root)
    const record = canonicalLocation(this.record)
    if (!contains(this.root, record)) return
    const [first] = protectedWorkspaceBranches(this.root, [record])
    if (process.platform === 'win32') {
      if (protectedPaths === undefined) return
      throw new WorkspaceContainsStateError()
    }
    if (first !== undefined
      && (protectedPaths === undefined || protectedPaths.some(path => canonicalLocation(path) === first))) return
    throw new Error('Protected input records must be outside the writable workspace or protected at its first child')
  }

  /**
   * Register an input without trusting edits made after write access was granted.
   * @param filename Protected input path; outside-workspace inputs remain unchanged.
   */
  observe(filename: string): void {
    const path = this.inputPath(filename)
    for (const record of this.ownerRecords) record.observe(filename)
    if (!contains(this.root, path)) return
    // Only mutable record storage is excluded; its ancestors also contain host inputs.
    if (this.isRecordStorage(path)) return
    if (!this.observed.has(path)) this.rootsVersion++
    this.observed.add(path)
    if (this.record === undefined && !this.approved.has(path)) {
      const pass = capturePass()
      const value = finishSync(this.capture(path, undefined, pass))
      finishSync(checkPass(pass))
      this.approved.set(path, value)
    }
  }

  /**
   * Capture a first grant or verify existing trust without accepting changed inputs.
   * @param protectedPaths Current native write exclusions.
   * @param signal Cancels only this waiter; omission waits for the shared operation to settle.
   * @returns Admission completion, shared only before scanning. Failed captures require explicit owner reauthorization.
   */
  ensureWrite(protectedPaths: readonly string[] = [], signal?: AbortSignal): Promise<void> {
    const generation = this.generation
    const current = (): void => {
      if (generation !== this.generation) throw new Error('Protected workspace generation was revoked or replaced')
    }
    this.assertRecordLocation(protectedPaths)
    const admit = (): Promise<void> => {
      current()
      if (this.isolatedReview) {
        return this.review({ blocked() {}, confirm: () => Promise.resolve(false) }).then((accepted) => {
          if (!accepted) throw new ProtectedInputReviewError()
          if (!this.granted && this.grant === undefined) return this.grantWrite(protectedPaths)
        })
      }
      this.refreshRecord()
      if (!this.granted && this.grant === undefined) return this.grantWrite(protectedPaths)
      return this.review({ blocked() {}, confirm: () => Promise.resolve(false) }).then((accepted) => {
        if (!accepted) throw new ProtectedInputReviewError()
      })
    }
    signal?.throwIfAborted()
    let batch = this.admission
    if (batch === undefined || !batch.enrolling || batch.roots !== this.rootsVersion) {
      const previous = batch?.promise ?? Promise.resolve()
      // Install the first-capture barrier synchronously, before confinement can wait on it.
      if (batch === undefined && !this.isolatedReview) this.refreshRecord()
      const capture = batch === undefined && !this.isolatedReview && !this.granted && this.grant === undefined
        ? this.grantWrite(protectedPaths) : undefined
      const next = { promise: Promise.resolve(), enrolling: true, roots: this.rootsVersion }
      const start = (): Promise<void> => {
        current()
        next.enrolling = false
        return capture ?? admit()
      }
      next.promise = previous.then(start, start)
      this.admission = batch = next
      const settled = (): void => {
        if (this.admission === next) this.admission = undefined
      }
      void next.promise.then(settled, settled)
    }
    const operation = batch.promise.then(() => { current() })
    if (signal === undefined) return operation
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        const reason: unknown = signal.reason
        reject(reason instanceof Error ? reason : new Error(String(reason), { cause: reason }))
      }
      signal.addEventListener('abort', abort, { once: true })
      void operation.then(() => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) abort()
        else resolve()
      }, (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
      })
    })
  }

  /**
   * Capture owner inputs after explicit owner consent, replacing any existing baseline before write access is published.
   * @param protectedPaths Native write exclusions; omission requires state outside the workspace.
   * @returns Shared pending capture; a failed capture denies consumers until a later explicit grant retries it.
   */
  grantWrite(protectedPaths: readonly string[] = []): Promise<void> {
    this.assertRecordLocation(protectedPaths)
    if (this.grant?.pending === true) return this.grant.promise
    this.grant = undefined
    this.refreshRecord()
    if (this.verifying) throw new Error('Protected host input verification is already pending')
    this.verifiedPass = undefined
    this.fileIndex.clear()
    this.approved.clear()
    const grant = { promise: this.captureGrant().catch((cause: unknown) => {
      grant.failed = true
      throw new Error(`${en.captureFailed} / ${zh.captureFailed} ${String(cause)}`, { cause })
    }), pending: true, failed: false }
    grant.promise = grant.promise.finally(() => { grant.pending = false })
    this.grant = grant
    return grant.promise
  }

  private assertCapturedRoots(candidates: ReadonlyMap<string, InputSnapshot>): void {
    for (const path of this.observed) {
      if (!candidates.has(path)) throw new Error(`Protected host input registered during capture: ${path}`)
    }
  }

  private async captureGrant(): Promise<void> {
    const generation = this.generation
    if (this.record !== undefined) mkdirSync(dirname(this.record), { recursive: true, mode: 0o700 })
    if (this.home !== undefined && contains(this.root, this.home)) {
      for (const tree of authoritativeHomeTrees(this.home)) mkdirSync(dirname(tree), { recursive: true, mode: 0o700 })
    }
    const pass = capturePass()
    const candidates = new Map<string, InputSnapshot>()
    for (const path of this.observed) candidates.set(path, await finishAsync(this.capture(path, undefined, pass)))
    await finishAsync(checkPass(pass))
    this.assertCapturedRoots(candidates)
    if (generation !== this.generation) throw new Error('Protected workspace generation was revoked or replaced')
    const previous = new Map(this.approved)
    const current = (): void => {
      if (generation !== this.generation) throw new Error('Protected workspace generation was revoked or replaced')
      this.assertCapturedRoots(candidates)
    }
    try { await this.persist(current, candidates); current() } catch (error) {
      if (generation === this.generation) {
        this.approved.clear()
        for (const [path, value] of previous) this.approved.set(path, value)
      }
      throw error
    }
    for (const [path, value] of candidates) this.approved.set(path, value)
    this.granted = true
    this.verifiedPass = { pass, roots: new Set(candidates.keys()) }
  }

  /**
   * Wait for the latest requested baseline without creating a grant; failure remains a denial until an explicit retry.
   * @returns Completion of the latest capture, including its failure.
   */
  async waitForCapture(): Promise<void> {
    await this.grant?.promise
  }

  /**
   * Query coverage without trusting a new path or changing the record; cyclic names use their recorded spelling.
   * @param filename Exact input or descendant of a recorded directory.
   * @returns Whether a granted baseline covers the path spelling.
   */
  covers(filename: string): boolean {
    this.refreshRecord()
    const path = this.inputPath(filename)
    if (this.isRecordStorage(path)) return false
    if (this.stateFailure !== undefined) return contains(this.root, path)
    return this.ownerRecords.some(record => record.covers(filename))
      || this.granted && [...this.approved].some(([root, value]) => root === path
        || ((value.kind === 'directory' || value.kind === 'link') && contains(root, path)))
  }

  /**
   * Read the approved configuration bytes, not a second read of a checked pathname.
   * @param filename Exact registered configuration input.
   * @returns Approved bytes, current bytes before a grant, or undefined for an approved absent input.
   */
  readTrusted(filename: string): Buffer | undefined {
    this.refreshRecord()
    const path = this.inputPath(filename)
    // Unsafe state must not redirect launch reads to either forged snapshots
    // or current workspace bytes. Optional workspace configuration is omitted.
    if (this.stateFailure !== undefined && contains(this.root, path)) return undefined
    const copies = this.ownerRecords.filter(record => record.covers(filename)).map(record => record.readTrusted(filename))
    if (this.granted && contains(this.root, path)) copies.push(this.readLocalTrusted(path))
    if (copies.length > 0) {
      const first = copies[0]
      if (copies.some(bytes => first === undefined ? bytes !== undefined : bytes === undefined || !first.equals(bytes))) {
        throw new Error(`Conflicting protected host input records: ${path}`)
      }
      return first
    }
    try { return readFileSync(path) } catch (error) {
      if (missing(error)) return undefined
      throw error
    }
  }

  private readLocalTrusted(path: string): Buffer | undefined {
    const copies: (Buffer | undefined)[] = []
    for (const [root, value] of this.approved) {
      if (root === path) {
        if (value.content !== null || value.blob !== undefined) copies.push(this.readCopy(value))
        else if (value.kind === 'missing') copies.push(undefined)
        else throw new Error(`Protected host input is not a configuration file: ${path}`)
      } else if ((value.kind === 'directory' || value.kind === 'link') && contains(root, path)) {
        if (value.files === undefined) throw new Error(`Protected host input has no approved copy: ${path}`)
        let index = this.fileIndex.get(root)
        if (index === undefined) {
          index = new Map()
          for (const file of value.files) if (!index.has(file.path)) index.set(file.path, file)
          this.fileIndex.set(root, index)
        }
        const file = index.get(path)
        copies.push(file === undefined ? undefined : this.readCopy(file))
      }
    }
    if (copies.length === 0) throw new Error(`Protected host input has no approved copy: ${path}`)
    const first = copies[0]
    if (copies.some(bytes => first === undefined ? bytes !== undefined : bytes === undefined || !first.equals(bytes))) {
      throw new Error(`Conflicting protected host input records: ${path}`)
    }
    return first
  }

  /**
   * Return the same module bytes included in the approved tree comparison.
   * @param filename Resolved executable input, including a recorded link's canonical target.
   * @returns Verified bytes, or undefined when this record does not protect the input.
   * @throws When a protected executable has changed or was not recorded before write access.
   */
  readExecutable(filename: string): Buffer | undefined {
    this.refreshRecord()
    if (this.stateFailure !== undefined && contains(this.root, this.inputPath(filename))) throw this.stateFailure
    const copies = [this.readLocalExecutable(filename), ...this.ownerRecords.map(record => record.readExecutable(filename))]
      .filter(bytes => bytes !== undefined)
    const first = copies[0]
    if (first !== undefined && copies.some(bytes => !first.equals(bytes))) {
      throw new Error(`Conflicting protected host input records: ${filename}`)
    }
    return first
  }

  private readLocalExecutable(filename: string): Buffer | undefined {
    if (!this.granted) return undefined
    const path = this.inputPath(filename)
    const roots = [...this.approved].flatMap(([root, value]) => {
      if (value.target !== null && canonicalLocation(root) !== value.target) {
        throw new Error(`Protected host input requires owner confirmation: ${root}`)
      }
      if (contains(root, path)) return [{ root, value, candidate: path }]
      if (value.target !== null && contains(value.target, path)) {
        return [{ root, value, candidate: resolve(root, relative(value.target, path)) }]
      }
      return []
    })
    if (roots.length === 0 && !contains(this.root, path)) return undefined
    let bytes: Buffer | undefined
    const pass = capturePass()
    for (const { root, value, candidate } of roots) {
      const files = new Map<string, Buffer>()
      const current = finishSync(this.capture(root, files, pass, candidate))
      if (!matches(value, current)) throw new Error(`Protected host input requires owner confirmation: ${root}`)
      const content = files.get(candidate)
      if (content !== undefined) {
        if (bytes !== undefined && !bytes.equals(content)) throw new Error(`Protected host input changed while being read: ${path}`)
        bytes = content
      }
    }
    finishSync(checkPass(pass))
    if (bytes === undefined) throw new Error(`Protected host input requires owner confirmation: ${path}`)
    return bytes
  }

  private async persist(current: () => void, candidates: ReadonlyMap<string, InputSnapshot>): Promise<void> {
    current()
    if (this.record === undefined) return
    this.assertRecordLocation()
    mkdirSync(dirname(this.record), { recursive: true, mode: 0o700 })
    this.assertRecordLocation()
    const lock = `${this.record}.lock`
    const temporary = `${this.record}.${randomUUID()}.new`
    if (this.reviewPrepare === undefined) mkdirSync(lock, { mode: 0o700 })
    else await this.reviewPrepare({ workspace: this.root, record: this.record, temporary })
    try {
      let storedRevision: string | undefined
      try { storedRevision = await finishAsync(contentDigest(this.record), this.reviewUnit) } catch (error) {
        if (!missing(error)) throw error
      }
      current()
      if (storedRevision !== this.revision) {
        throw new Error('Protected workspace record changed in another host; reopen it before granting trust')
      }
      const descriptor = openSync(temporary, 'wx', 0o600)
      const revision = createHash('sha256')
      const append = (text: string): void => {
        const bytes = Buffer.from(text)
        revision.update(bytes)
        let offset = 0
        while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
      }
      const encode = function* (root: string, approved: ReadonlyMap<string, InputSnapshot>): Generator<void, void> {
        append(`{"version":1,"workspace":${JSON.stringify(root)},"inputs":[`)
        let separator = ''
        for (const [path, value] of approved) {
          const { files, ...metadata } = value
          append(`${separator}{"path":${JSON.stringify(path)},"snapshot":${JSON.stringify(metadata).slice(0, -1)}`)
          if (files !== undefined) {
            append(',"files":[')
            let fileSeparator = ''
            for (const file of files) {
              append(fileSeparator + JSON.stringify(file))
              fileSeparator = ','
              yield
            }
            append(']')
          }
          append('}}')
          separator = ','
          yield
        }
        append(']}\n')
      }
      try {
        await finishAsync(encode(this.root, candidates), () => { current(); this.reviewUnit?.() })
      } finally { closeSync(descriptor) }
      const nextRevision = revision.digest('hex')
      current()
      if (this.reviewCommit === undefined) {
        renameSync(temporary, this.record)
        this.revision = nextRevision
      } else {
        this.revision = await this.reviewCommit({ workspace: this.root, record: this.record, temporary,
          previous: this.revision, revision: nextRevision })
        current()
      }
    } finally {
      try { unlinkSync(temporary) } catch (error) {
        if (!missing(error)) throw error
      }
      if (this.reviewPrepare === undefined) rmdirSync(lock)
    }
  }

  /**
   * Queue a host admission review without overlapping another coordinated review.
   * @param owner Authenticated confirmation and visible refusal reporting for this request only.
   * @returns This request's fresh verification result; stale generations and changed roots reject queued work.
   */
  review(owner: ProtectedInputOwner): Promise<boolean> {
    const current = this.checkpoint()
    const operation = this.reviews.then(async () => {
      current()
      const accepted = await this.verify(owner)
      current()
      return accepted
    })
    this.reviews = operation.then(() => {}, () => {})
    return operation
  }

  /**
   * Compare every known input before reading a new configuration or module generation.
   * @param owner Authenticated confirmation and visible refusal reporting.
   * @returns Whether every input still matches its approved identity and bytes; ungranted workspaces need no approval.
   */
  async verify(owner: ProtectedInputOwner): Promise<boolean> {
    const operation = this.verifyInputs(owner)
    this.activeReviews.add(operation)
    try { return await operation } finally { this.activeReviews.delete(operation) }
  }

  private async verifyInputs(owner: ProtectedInputOwner): Promise<boolean> {
    const current = this.checkpoint()
    await this.waitForCapture()
    current()
    if (this.verifying) throw new Error('Protected host input verification is already pending')
    if (this.isolatedReview && this.home !== undefined) {
      this.verifying = true
      const prepared = new Map<string, { lock: string; stamp: string | undefined }>()
      try {
        let completed = -1
        const records = [this, ...this.ownerRecords]
        const guards = records.map(record => ({ record, current: record.checkpoint(), revision: record.revision,
          stamp: record.record === undefined ? undefined : treeStamp(record.record) }))
        const assertCurrent = (): void => {
          current()
          for (const guard of guards) {
            guard.current()
            if (ProtectedInputIntegrity.workspaceKey(guard.record.workspace, guard.record.home) !== guard.record.workspaceIdentity) {
              throw new Error('Protected input workspace identity changed during review')
            }
            const path = guard.record.record
            if (path !== undefined && treeStamp(path) !== guard.stamp
              && createHash('sha256').update(readFileSync(path)).digest('hex') !== guard.revision) {
              throw new Error('Protected workspace record changed during review')
            }
          }
        }
        const commit = (value: unknown): string => {
          assertCurrent()
          if (typeof value !== 'object' || value === null || !('record' in value) || typeof value.record !== 'string'
            || !('workspace' in value) || typeof value.workspace !== 'string'
            || !('temporary' in value) || typeof value.temporary !== 'string'
            || !('previous' in value) || !('revision' in value) || typeof value.revision !== 'string'
            || !/^[a-f0-9]{64}$/u.test(value.revision)) throw new Error('Invalid protected input commit request')
          const guard = guards.find(candidate => candidate.record.record === value.record && candidate.record.root === value.workspace)
          if (guard === undefined || !prepared.has(value.temporary) || value.previous !== guard.revision
            || !value.temporary.startsWith(`${value.record}.`)
            || !/^[a-f0-9-]{36}\.new$/u.test(value.temporary.slice(value.record.length + 1))) {
            throw new Error('Protected input commit does not match the reviewed generation')
          }
          guard.record.assertRecordLocation()
          assertCurrent()
          const owned = prepared.get(value.temporary)
          if (owned === undefined || treeStamp(owned.lock) !== owned.stamp) throw new Error('Protected input publication lock was replaced')
          // This host owns both the record lock and the final rename.
          renameSync(value.temporary, value.record)
          guard.revision = value.revision
          guard.stamp = treeStamp(value.record)
          return value.revision
        }
        const cacheKey = this.reviewIdentity()
        const reuse = this.reviewThread.available && this.reviewCacheKey === cacheKey
        if (!reuse) {
          await this.reviewThread.dispose()
          assertCurrent()
          this.verifiedPass = undefined
          for (const record of this.ownerRecords) record.verifiedPass = undefined
        }
        const result = await runInputReviewThread({ kind: 'verify', workspace: this.workspace, home: this.home,
          cacheKey, ...reuse ? {} : { state: this.exportReviewState() } }, (value) => {
          if (value.completed <= completed) return
          completed = value.completed
          this.reviewProgress(`${en.reviewProgress(completed, value.total)} / ${zh.reviewProgress(completed, value.total)}`)
        }, async (value) => {
          if (typeof value !== 'object' || value === null || !('path' in value) || typeof value.path !== 'string'
            || !('previous' in value) || typeof value.previous !== 'string' || !('current' in value) || typeof value.current !== 'string') {
            throw new Error('Invalid protected input worker confirmation')
          }
          const change = { path: value.path, previous: value.previous, current: value.current }
          owner.blocked(change)
          const accepted = await owner.confirm(change)
          assertCurrent()
          return accepted
        }, commit, this.reviewThread, (value) => {
          assertCurrent()
          if (typeof value !== 'object' || value === null || !('record' in value) || typeof value.record !== 'string'
            || !('workspace' in value) || typeof value.workspace !== 'string'
            || !('temporary' in value) || typeof value.temporary !== 'string') throw new Error('Invalid protected input prepare request')
          const guard = guards.find(candidate => candidate.record.record === value.record && candidate.record.root === value.workspace)
          if (guard === undefined || !value.temporary.startsWith(`${value.record}.`)
            || !/^[a-f0-9-]{36}\.new$/u.test(value.temporary.slice(value.record.length + 1))) {
            throw new Error('Protected input preparation does not match the reviewed generation')
          }
          guard.record.assertRecordLocation()
          const lock = `${value.record}.lock`
          mkdirSync(lock, { mode: 0o700 })
          prepared.set(value.temporary, { lock, stamp: treeStamp(lock) })
        })
        assertCurrent()
        if (typeof result !== 'object' || result === null || !('accepted' in result) || typeof result.accepted !== 'boolean'
          || !('cacheKey' in result) || result.cacheKey !== cacheKey) throw new Error('Invalid protected input worker result')
        if (!('state' in result)) {
          if (!reuse || !('identity' in result) || result.identity !== this.reviewWorkerIdentity) {
            throw new Error('Protected input worker generation does not match')
          }
          if (result.accepted) this.reviewCacheKey = cacheKey
          else await this.resetReview()
          return result.accepted
        }
        const updated = await ProtectedInputIntegrity.fromReviewState(result.state, assertCurrent)
        assertCurrent()
        if (updated.workspaceIdentity !== this.workspaceIdentity) throw new Error('Protected input worker changed workspace')
        if (result.accepted) {
          const assertObserved = (before: ProtectedInputIntegrity, after: ProtectedInputIntegrity): void => {
            if ([...before.observed].some(path => !after.observed.has(path))) throw new Error('Protected host input registered during capture')
            for (const owner of before.ownerRecords) {
              const reviewed = after.ownerRecords.find(record => record.workspaceIdentity === owner.workspaceIdentity)
              if (reviewed === undefined) throw new Error('Protected host input owner missing during capture')
              assertObserved(owner, reviewed)
            }
          }
          assertObserved(this, updated)
          assertCurrent()
          this.granted = updated.granted
          this.approved = updated.approved
          this.fileIndex = updated.fileIndex
          this.revision = updated.revision
          this.loadedStamp = updated.loadedStamp
          this.verifiedPass = updated.verifiedPass
          this.ownerRecords.splice(0, this.ownerRecords.length, ...updated.ownerRecords)
        }
        this.reviewCacheKey = this.reviewIdentity()
        this.reviewWorkerIdentity = updated.reviewIdentity()
        if (!result.accepted || this.reviewCacheKey !== cacheKey) await this.resetReview()
        assertCurrent()
        return result.accepted
      } catch (error) {
        this.reviewCacheKey = undefined
        await this.reviewThread.dispose()
        throw error
      } finally {
        try {
          for (const [temporary, { lock, stamp }] of prepared) {
            if (treeStamp(lock) !== stamp) throw new Error('Protected input publication lock was replaced')
            try { unlinkSync(temporary) } catch (error) { if (!missing(error)) throw error }
            rmdirSync(lock)
          }
        } finally { this.verifying = false }
      }
    }
    this.refreshRecord()
    if (this.stateFailure !== undefined) return false
    this.verifying = true
    try {
      for (const record of this.ownerRecords) if (!await record.verify(owner)) return false
      return !this.granted || await this.verifyCandidate(owner)
    } finally { this.verifying = false }
  }

  private async verifyCandidate(owner: ProtectedInputOwner): Promise<boolean> {
    const generation = this.generation
    const current = this.checkpoint()
    const cached = this.verifiedPass
    if (cached !== undefined && await finishAsync(reusablePass(cached.pass), this.reviewUnit)
      && [...this.observed].every(path => cached.roots.has(path))) { current(); return true }
    this.verifiedPass = undefined
    const changes: ProtectedInputChange[] = []
    const candidates = new Map<string, InputSnapshot>()
    const captured = capturePass()
    if (cached !== undefined) captured.previous = cached.pass
    for (const path of this.observed) {
      const previous = this.approved.get(path)?.digest ?? 'unrecorded'
      const value = await finishAsync(this.capture(path, undefined, captured), this.reviewUnit)
      this.reviewUnit?.()
      candidates.set(path, value)
      const approved = this.approved.get(path)
      if (approved === undefined || !matches(approved, value)) changes.push({ path, previous, current: value.digest })
    }
    await finishAsync(checkPass(captured), this.reviewUnit)
    for (const change of changes) {
      owner.blocked(change)
      if (!await owner.confirm(change)) return false
    }
    delete captured.previous
    const checked = capturePass()
    checked.previous = captured
    for (const [path, candidate] of candidates) {
      const current = await finishAsync(this.capture(path, undefined, checked), this.reviewUnit)
      this.reviewUnit?.()
      if (!matches(candidate, current) || !matches(current, candidate)) {
        owner.blocked({ path, previous: candidate.digest, current: current.digest })
        return false
      }
    }
    await finishAsync(checkPass(checked), this.reviewUnit)
    this.assertCapturedRoots(candidates)
    current()
    const previous = new Map(this.approved)
    const tightened = [...candidates].some(([path, candidate]) => {
      const before = previous.get(path)
      return before !== undefined && !matches(candidate, before)
    })
    try {
      current()
      if (changes.length > 0 || tightened) await this.persist(current, candidates)
      current()
    } catch (error) {
      if (generation === this.generation) {
        this.approved.clear()
        for (const [path, value] of previous) this.approved.set(path, value)
      }
      throw error
    }
    this.fileIndex.clear()
    for (const [path, candidate] of candidates) this.approved.set(path, candidate)
    delete checked.previous
    this.verifiedPass = { pass: checked, roots: new Set(candidates.keys()) }
    return true
  }
}
