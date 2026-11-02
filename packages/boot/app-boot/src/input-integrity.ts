/** Host-owned identities and trusted bytes for executable inputs inside a writable workspace. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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

function snapshot(path: string, root: string, files?: Map<string, Buffer>): InputSnapshot {
  const hash = createHash('sha256')
  for (let current = path; contains(root, current); current = dirname(current)) {
    hash.update(current).update('\0').update(identity(current)).update('\0')
    if (current === dirname(current)) break
  }
  const visited = new Set<string>()
  const walk = (filename: string): Buffer | null => {
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
  return { digest: hash.digest('hex'), kind, target, content }
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
  return { digest: value.digest, kind, target: value.target, content: value.content }
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
    let text: string
    try { text = readFileSync(this.record, 'utf8') } catch (error) {
      if (missing(error)) return
      throw error
    }
    this.assertRecordLocation()
    this.revision = text
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1
      || !('workspace' in parsed) || parsed.workspace !== this.root || !('inputs' in parsed)
      || !Array.isArray(parsed.inputs)) throw new Error('Invalid protected workspace record')
    const inputs: unknown[] = parsed.inputs
    for (const item of inputs) {
      if (typeof item !== 'object' || item === null || !('path' in item) || typeof item.path !== 'string'
        || !contains(this.root, item.path) || !('snapshot' in item)) throw new Error('Invalid protected input path')
      this.approved.set(item.path, parseSnapshot(item.snapshot))
      this.observed.add(item.path)
    }
    this.granted = true
  }

  private inputPath(filename: string): string {
    const path = resolve(filename)
    return contains(this.workspace, path) ? resolve(this.root, relative(this.workspace, path)) : path
  }

  private assertRecordLocation(): void {
    if (this.record !== undefined && (contains(this.root, this.record)
      || contains(this.root, canonicalLocation(this.record)))) {
      throw new Error('Protected input records must be outside the writable workspace')
    }
  }

  /**
   * Register an input without trusting edits made after write access was granted.
   * @param filename Protected input path; outside-workspace inputs remain unchanged.
   */
  observe(filename: string): void {
    const path = this.inputPath(filename)
    if (!contains(this.root, path)) return
    this.observed.add(path)
    if (this.record === undefined && !this.approved.has(path)) this.approved.set(path, snapshot(path, this.root))
  }

  /** Capture the current owner inputs before publishing workspace write access; existing grants never reset trust. */
  grantWrite(): void {
    if (this.granted) return
    this.assertRecordLocation()
    for (const path of this.observed) this.approved.set(path, snapshot(path, this.root))
    this.persist()
    this.granted = true
  }

  /**
   * Query coverage without trusting a new path or changing the record.
   * @param filename Exact input or descendant of a recorded directory.
   * @returns Whether a granted baseline covers the path spelling.
   */
  covers(filename: string): boolean {
    const path = this.inputPath(filename)
    return this.granted && [...this.approved].some(([root, value]) => root === path
      || ((value.kind === 'directory' || value.kind === 'link') && contains(root, path)))
  }

  /**
   * Read the approved configuration bytes, not a second read of a checked pathname.
   * @param filename Exact registered configuration input.
   * @returns Approved bytes, current bytes before a grant, or undefined for an approved absent input.
   */
  readTrusted(filename: string): Buffer | undefined {
    const path = this.inputPath(filename)
    if (!this.granted || !contains(this.root, path)) {
      try { return readFileSync(path) } catch (error) {
        if (missing(error)) return undefined
        throw error
      }
    }
    const value = this.approved.get(path)
    if (value === undefined) throw new Error(`Protected host input has no approved copy: ${path}`)
    if (value.content !== null) return Buffer.from(value.content, 'base64')
    if (value.kind === 'missing') return undefined
    throw new Error(`Protected host input is not a configuration file: ${path}`)
  }

  /**
   * Return the same module bytes included in the approved tree comparison.
   * @param filename Resolved executable input, including a recorded link's canonical target.
   * @returns Verified bytes, or undefined when this record does not protect the input.
   * @throws When a protected executable has changed or was not recorded before write access.
   */
  readExecutable(filename: string): Buffer | undefined {
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
    for (const { root, value, candidate } of roots) {
      const files = new Map<string, Buffer>()
      const current = snapshot(root, this.root, files)
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
    if (!this.granted) return true
    if (this.verifying) throw new Error('Protected host input verification is already pending')
    this.verifying = true
    try { return await this.verifyCandidate(owner) } finally { this.verifying = false }
  }

  private async verifyCandidate(owner: ProtectedInputOwner): Promise<boolean> {
    const changes: ProtectedInputChange[] = []
    const candidates = new Map<string, InputSnapshot>()
    for (const path of this.observed) {
      const previous = this.approved.get(path)?.digest ?? 'unrecorded'
      const value = snapshot(path, this.root)
      candidates.set(path, value)
      if (value.digest !== previous) changes.push({ path, previous, current: value.digest })
    }
    for (const change of changes) {
      owner.blocked(change)
      if (!await owner.confirm(change)) return false
    }
    for (const [path, candidate] of candidates) {
      const current = snapshot(path, this.root).digest
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
