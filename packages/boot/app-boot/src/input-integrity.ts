/** Host-owned identities and trusted bytes for executable inputs inside a writable workspace. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertWindowsStateTrusted } from '@panedesk/dsh-sandbox-windows-acl'

/** Windows policy refuses workspace writes that include owner-state storage. */
export class WorkspaceContainsStateError extends Error {
  constructor() {
    super('The workspace contains the Panedesk state directory; choose one of its subdirectories. / 工作区包含 Panedesk 状态目录，请选它的子目录。 Protected input records must be outside the writable workspace.')
    this.name = 'WorkspaceContainsStateError'
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

interface InputSnapshot {
  digest: string
  kind: 'missing' | 'file' | 'directory' | 'link' | 'other'
  target: string | null
  content: string | null
  files?: readonly { path: string; content: string }[]
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

function identity(path: string): string {
  try {
    const stat = lstatSync(path, { bigint: true })
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.mode}:${stat.isSymbolicLink() ? realpathSync(path) : ''}`
  } catch (error) {
    if (missing(error)) return 'missing'
    throw error
  }
}

function treeStamp(path: string): string {
  try {
    const link = lstatSync(path, { bigint: true })
    const target = statSync(path, { bigint: true })
    return [realpathSync(path), ...[link, target].map(stat =>
      `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`)].join('\0')
  } catch (error) {
    if (missing(error)) return 'missing'
    throw error
  }
}

function snapshot(
  path: string, root: string, files?: Map<string, Buffer>, stamps = new Map<string, string>(), excluded?: string,
): InputSnapshot {
  const hash = createHash('sha256')
  const copies: { path: string; content: string }[] = []
  const capture = (filename: string): void => {
    if (!stamps.has(filename)) stamps.set(filename, treeStamp(filename))
  }
  for (let current = path; contains(root, current); current = dirname(current)) {
    capture(current)
    hash.update(current).update('\0').update(identity(current)).update('\0')
    if (current === dirname(current)) break
  }
  const visited = new Set<string>()
  const walk = (filename: string): Buffer | null => {
    if (excluded !== undefined && contains(excluded, canonicalLocation(filename))) return null
    capture(filename)
    hash.update(filename).update('\0').update(identity(filename)).update('\0')
    let stat: ReturnType<typeof statSync>
    try { stat = statSync(filename) } catch (error) {
      if (missing(error)) return null
      throw error
    }
    if (stat.isFile()) {
      const descriptor = openSync(filename, 'r')
      try {
        const before = fstatSync(descriptor, { bigint: true })
        const bytes = readFileSync(descriptor)
        const after = fstatSync(descriptor, { bigint: true })
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
          || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
          throw new Error(`Protected host input changed while being read: ${filename}`)
        }
        hash.update(bytes).update('\0')
        files?.set(filename, bytes)
        copies.push({ path: filename, content: bytes.toString('base64') })
        return bytes
      } finally {
        closeSync(descriptor)
      }
    }
    if (stat.isDirectory()) {
      const target = realpathSync(filename)
      if (visited.has(target)) return null
      visited.add(target)
      for (const name of readdirSync(filename).sort()) walk(join(filename, name))
    }
    return null
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
  const content = walk(path)?.toString('base64') ?? null
  for (const [filename, before] of stamps) {
    if (treeStamp(filename) !== before) throw new Error(`Protected host input changed while being read: ${filename}`)
  }
  return { digest: hash.digest('hex'), kind, target, content, files: copies }
}

function parseSnapshot(value: unknown): InputSnapshot {
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
  const files: { path: string; content: string }[] = []
  if ('files' in value) {
    if (!Array.isArray(value.files)) throw new Error('Invalid protected input copies')
    const entries: unknown[] = value.files
    for (const file of entries) {
      if (typeof file !== 'object' || file === null || !('path' in file) || typeof file.path !== 'string'
        || !('content' in file) || typeof file.content !== 'string') throw new Error('Invalid protected input copy')
      files.push({ path: file.path, content: file.content })
    }
  }
  return { digest: value.digest, kind, target: value.target, content: value.content,
    ...'files' in value ? { files } : {},
  }
}

/** A workspace's owner-approved input set; rejected reads never replace its baseline. */
export class ProtectedInputIntegrity {
  private readonly approved = new Map<string, InputSnapshot>()
  private readonly observed = new Set<string>()
  private readonly root: string
  private readonly workspace: string
  private readonly record: string | undefined
  private granted: boolean
  private revision: string | undefined
  private verifying = false
  private stateFailure: Error | undefined

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

  /**
   * Open every granted workspace for an owner before parsing any launch input.
   * @param workspace Launch workspace; opening it does not grant write access.
   * @param home Owner state root containing the durable workspace records.
   * @returns A reader that rejects inconsistent overlapping records instead of reading current files.
   */
  static openOwnerRecords(workspace: string, home: string): ProtectedInputIntegrity {
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
      const parsed: unknown = JSON.parse(readFileSync(filename, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || !('workspace' in parsed)
        || typeof parsed.workspace !== 'string' || !isAbsolute(parsed.workspace)) {
        throw new Error('Invalid protected workspace record')
      }
      const record = new ProtectedInputIntegrity(parsed.workspace, home)
      if (record.record !== filename || !record.granted) throw new Error('Invalid protected workspace record location')
      if (record.root !== reader.root) reader.ownerRecords.push(record)
    }
    const records = [reader, ...reader.ownerRecords]
    const paths = new Set(records.flatMap(record => [...record.approved].flatMap(([path, value]) => [
      ...value.kind === 'file' || value.content !== null ? [path] : [],
      ...value.files?.map(file => file.path) ?? [],
    ])))
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
    }
    return reader
  }

  /**
   * @param workspace Absolute writable workspace whose executable inputs require confirmation.
   * @param home Owner state root outside the workspace; omission retains process-local observation semantics.
   */
  constructor(workspace: string, home?: string) {
    this.workspace = resolve(workspace)
    this.root = canonicalLocation(this.workspace)
    this.granted = home === undefined
    if (home === undefined) return
    const directory = join(resolve(home), 'windows-workspace-write', 'protected-inputs')
    this.record = join(directory, `${createHash('sha256').update(this.root).digest('hex')}.json`)
    if (!this.stateTrusted()) return
    let text: string
    try { text = readFileSync(this.record, 'utf8') } catch (error) {
      if (missing(error)) return
      throw error
    }
    this.loadRecord(text)
  }

  private loadRecord(text: string): void {
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
    this.approved.clear()
    for (const [path, value] of approved) {
      this.approved.set(path, value)
      this.observed.add(path)
    }
    this.revision = text
    this.granted = true
  }

  private refreshRecord(): void {
    if (this.record === undefined || this.verifying || !this.stateTrusted()) return
    if (this.revision !== undefined) this.assertRecordLocation()
    let text: string
    try { text = readFileSync(this.record, 'utf8') } catch (error) {
      if (!missing(error)) throw error
      if (this.revision !== undefined) throw new Error('Protected workspace record disappeared')
      return
    }
    if (text !== this.revision) this.loadRecord(text)
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

  private capture(path: string, files?: Map<string, Buffer>, stamps = new Map<string, string>()): InputSnapshot {
    return snapshot(path, this.root, files, stamps,
      this.record === undefined ? undefined : canonicalLocation(dirname(this.record)))
  }

  private assertRecordLocation(protectedPaths?: readonly string[]): void {
    if (this.record === undefined) return
    assertWindowsStateTrusted(this.record, this.root)
    const record = canonicalLocation(this.record)
    if (!contains(this.root, record)) return
    const [child = ''] = relative(this.root, record).split(sep)
    const first = join(this.root, child)
    if (process.platform === 'win32') {
      if (protectedPaths === undefined) return
      throw new WorkspaceContainsStateError()
    }
    if (first !== this.root
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
    this.observed.add(path)
    if (this.record === undefined && !this.approved.has(path)) this.approved.set(path, this.capture(path))
  }

  /**
   * Capture owner inputs before publishing write access; existing grants never reset trust.
   * @param protectedPaths Native write exclusions; omission requires state outside the workspace.
   */
  grantWrite(protectedPaths: readonly string[] = []): void {
    this.assertRecordLocation(protectedPaths)
    this.refreshRecord()
    if (this.granted) return
    if (this.record !== undefined) mkdirSync(dirname(this.record), { recursive: true, mode: 0o700 })
    const stamps = new Map<string, string>()
    const candidates = new Map<string, InputSnapshot>()
    for (const path of this.observed) candidates.set(path, this.capture(path, undefined, stamps))
    const previous = new Map(this.approved)
    for (const [path, value] of candidates) this.approved.set(path, value)
    try { this.persist() } catch (error) {
      this.approved.clear()
      for (const [path, value] of previous) this.approved.set(path, value)
      throw error
    }
    this.granted = true
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
        if (value.content !== null) copies.push(Buffer.from(value.content, 'base64'))
        else if (value.kind === 'missing') copies.push(undefined)
        else throw new Error(`Protected host input is not a configuration file: ${path}`)
      } else if ((value.kind === 'directory' || value.kind === 'link') && contains(root, path)) {
        if (value.files === undefined) throw new Error(`Protected host input has no approved copy: ${path}`)
        const file = value.files.find(file => file.path === path)
        copies.push(file === undefined ? undefined : Buffer.from(file.content, 'base64'))
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
    const stamps = new Map<string, string>()
    for (const { root, value, candidate } of roots) {
      const files = new Map<string, Buffer>()
      const current = this.capture(root, files, stamps)
      if (current.digest !== value.digest) throw new Error(`Protected host input requires owner confirmation: ${root}`)
      const content = files.get(candidate)
      if (content !== undefined) {
        if (bytes !== undefined && !bytes.equals(content)) throw new Error(`Protected host input changed while being read: ${path}`)
        bytes = content
      }
    }
    if (bytes === undefined) throw new Error(`Protected host input requires owner confirmation: ${path}`)
    return bytes
  }

  private persist(): void {
    if (this.record === undefined) return
    this.assertRecordLocation()
    mkdirSync(dirname(this.record), { recursive: true, mode: 0o700 })
    this.assertRecordLocation()
    const lock = `${this.record}.lock`
    mkdirSync(lock, { mode: 0o700 })
    const temporary = `${this.record}.${randomUUID()}.new`
    try {
      let current: string | undefined
      try { current = readFileSync(this.record, 'utf8') } catch (error) {
        if (!missing(error)) throw error
      }
      if (current !== this.revision) throw new Error('Protected workspace record changed in another host; reopen it before granting trust')
      const text = JSON.stringify({ version: 1, workspace: this.root,
        inputs: [...this.approved].map(([path, value]) => ({ path, snapshot: value })),
      }) + '\n'
      writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.record)
      this.revision = text
    } finally {
      try { unlinkSync(temporary) } catch (error) {
        if (!missing(error)) throw error
      }
      rmdirSync(lock)
    }
  }

  /**
   * Compare every known input before reading a new configuration or module generation.
   * @param owner Authenticated confirmation and visible refusal reporting.
   * @returns Whether every input still matches its approved identity and bytes; ungranted workspaces need no approval.
   */
  async verify(owner: ProtectedInputOwner): Promise<boolean> {
    if (this.verifying) throw new Error('Protected host input verification is already pending')
    this.refreshRecord()
    if (this.stateFailure !== undefined) return false
    this.verifying = true
    try {
      for (const record of this.ownerRecords) if (!await record.verify(owner)) return false
      return !this.granted || await this.verifyCandidate(owner)
    } finally { this.verifying = false }
  }

  private async verifyCandidate(owner: ProtectedInputOwner): Promise<boolean> {
    const changes: ProtectedInputChange[] = []
    const candidates = new Map<string, InputSnapshot>()
    const captured = new Map<string, string>()
    for (const path of this.observed) {
      const previous = this.approved.get(path)?.digest ?? 'unrecorded'
      const value = this.capture(path, undefined, captured)
      candidates.set(path, value)
      if (value.digest !== previous) changes.push({ path, previous, current: value.digest })
    }
    for (const change of changes) {
      owner.blocked(change)
      if (!await owner.confirm(change)) return false
    }
    const checked = new Map<string, string>()
    for (const [path, candidate] of candidates) {
      const current = this.capture(path, undefined, checked).digest
      if (current !== candidate.digest) {
        owner.blocked({ path, previous: candidate.digest, current })
        return false
      }
    }
    const previous = new Map(this.approved)
    for (const [path, candidate] of candidates) this.approved.set(path, candidate)
    try { if (changes.length > 0) this.persist() } catch (error) {
      this.approved.clear()
      for (const [path, value] of previous) this.approved.set(path, value)
      throw error
    }
    return true
  }
}
