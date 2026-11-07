/** Product-home authorization records; one atomic file per canonical workspace avoids lost sibling updates. */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { setTimeout as wait } from 'node:timers/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { withFileLock, writeFileAtomic } from '@panedesk/dsh-atomic-write'
import { assertOwnerWorkspace, canonicalPath, protectedWorkspaceBranches } from '@panedesk/dsh-sandbox'
import { assertWindowsStateTrusted } from '@panedesk/dsh-sandbox-windows-acl'

/** An evaluated workspace rule denied authorization; inspection failures use their original error. */
export class WorkspaceWriteRuleError extends Error {}

const recordSchema = z.object({
  workspace: z.string().min(1),
  grantedAt: z.iso.datetime(),
  source: z.enum(['first-confirmation', 'settings-preauthorization']),
}).strict()

/** A committed user authorization; absence never grants write access. */
export type WorkspaceWriteRecord = z.infer<typeof recordSchema>

/** Home-scoped durable grants shared by every profile. Invalid or unreadable records fail closed. */
export class WorkspaceWriteAccess {
  private readonly directory: string
  private readonly epochs = new Map<string, AbortController>()
  private readonly issued = new Set<string>()

  /** Capture the current process-local generation before asynchronous work.
   * @param workspace Canonical workspace or an alias.
   * @returns A guard that rejects after an owner transition.
   */
  checkpoint(workspace: string): () => void {
    const root = canonicalPath(workspace)
    let epoch = this.epochs.get(root)
    if (epoch === undefined) { epoch = new AbortController(); this.epochs.set(root, epoch) }
    const { signal } = epoch
    return () => { signal.throwIfAborted() }
  }

  private advance(workspace: string): void {
    const root = canonicalPath(workspace)
    this.epochs.get(root)?.abort(new Error('Workspace write generation was revoked or replaced'))
    this.epochs.set(root, new AbortController())
    this.invalidateInputs(root)
  }

  /** Invalidate earlier work before capturing a new owner grant.
   * @param workspace Existing workspace selected by the owner.
   * @returns The new generation's submission guard.
   */
  beginGrant(workspace: string): () => void {
    this.advance(workspace)
    if (this.issued.has(canonicalPath(workspace))) {
      throw new WorkspaceWriteRuleError('Previously issued workspace capabilities have no completion proof; restart the host before reauthorizing. / 先前发出的工作区写能力没有完成证明；请重启宿主后再授权。')
    }
    return this.checkpoint(workspace)
  }

  /** Record a capability that can outlive its argv publisher.
   * @param workspace Workspace whose executions cannot yet be proven drained.
   */
  issuedCapability(workspace: string): void {
    this.issued.add(canonicalPath(workspace))
  }

  /** Roll back only the generation that committed the failed approval.
   * @param workspace Workspace being rolled back.
   * @param current Guard captured before authorization.
   * @param revokeAcl Native revocation for the same generation.
   */
  async rollback(workspace: string, current: () => void, revokeAcl: (workspace: string) => void): Promise<void> {
    try { current() } catch (error) {
      if (!(error instanceof Error)) throw error
      return
    }
    await this.revokeCurrent(workspace, revokeAcl, current)
  }

  /**
   * @param home - Resolved product home, never the current workspace.
   * @param protectedPaths - Live host inputs; omitted for record-only inventory and revocation consumers.
   * @param profileDirectory - Current protected profile, used for actionable workspace diagnostics.
   * @param ownerDirectories - Live private-storage inventory; omission is for record-only consumers.
   * @param invalidateInputs - Revoke pending profile captures and reviews before an owner transition.
   */
  constructor(home: string, private readonly protectedPaths: (workspace: string) => readonly string[] = () => [],
    private readonly profileDirectory: () => string | undefined = () => undefined,
    private readonly ownerDirectories: () => readonly string[] = () => [],
    private readonly invalidateInputs: (workspace: string) => void = () => {}) {
    this.directory = join(home, 'windows-workspace-write')
  }

  private assertUnprotected(workspace: string): void {
    const contains = (root: string, path: string): boolean => {
      const suffix = relative(root, path)
      return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
    }
    try { assertOwnerWorkspace(workspace, this.ownerDirectories(), process.platform === 'win32') } catch (error) {
      if (!(error instanceof Error)) throw error
      throw new WorkspaceWriteRuleError(error.message)
    }
    const protectedPaths = this.protectedPaths(workspace).map(canonicalPath)
    const directory = canonicalPath(this.directory)
    if (contains(workspace, directory)) {
      if (process.platform === 'win32') {
        throw new WorkspaceWriteRuleError('The workspace contains the Panedesk state directory; choose one of its subdirectories. / 工作区包含 Panedesk 状态目录，请选它的子目录。')
      }
      const [first] = protectedWorkspaceBranches(workspace, [directory])
      if (first === undefined || !protectedPaths.includes(first)) {
        throw new WorkspaceWriteRuleError('Workspace authorization records must be outside the writable workspace or protected at its first child')
      }
    }
    const profile = this.profileDirectory()
    if (profile !== undefined && contains(canonicalPath(profile), workspace)) {
      throw new WorkspaceWriteRuleError('This directory is a protected profile directory; choose another workspace. / 该目录是受保护的 profile 目录，请换一个工作区。')
    }
    for (const path of protectedPaths) {
      if (contains(path, workspace)) {
        throw new WorkspaceWriteRuleError(`Workspace write authorization overlaps protected host path ${JSON.stringify(path)}`)
      }
    }
  }

  /**
   * Reject ineligible workspaces without creating records or changing ACLs.
   * @param workspace - Existing absolute workspace directory.
   */
  assertCanAuthorize(workspace: string): void {
    const canonical = this.canonical(workspace)
    this.assertUnprotected(canonical)
    assertWindowsStateTrusted(this.identityPath(canonical), canonical)
    if (this.revocationPending(this.identityPath(canonical))) {
      throw new WorkspaceWriteRuleError('Workspace revocation is incomplete; retry revocation before authorizing')
    }
  }

  /**
   * Resolve aliases before deriving the record identity, matching the Windows ACL provider.
   * @param workspace - Existing absolute workspace directory.
   * @returns The native canonical directory path.
   */
  canonical(workspace: string): string {
    if (!isAbsolute(workspace)) throw new Error('Workspace write access requires an absolute directory')
    const canonical = realpathSync.native(workspace)
    if (!statSync(canonical).isDirectory()) throw new Error('Workspace write access requires a directory')
    return canonical
  }

  /**
   * Locate the record without creating directories or touching ACLs.
   * @param workspace - Existing absolute workspace directory.
   * @returns The home-level record filename.
   */
  recordPath(workspace: string): string {
    return this.identityPath(this.canonical(workspace))
  }

  private identityPath(workspace: string): string {
    const digest = createHash('sha256').update(workspace).digest('hex')
    return join(this.directory, `${digest}.json`)
  }

  private revocationTargetExists(workspace: string): boolean {
    let current = workspace
    for (;;) {
      let exists = true
      try { lstatSync(current) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        exists = false
      }
      if (exists) {
        if (this.canonical(current) !== current) throw new Error('Workspace revocation identity changed')
        return current === workspace
      }
      const parent = dirname(current)
      if (parent === current) throw new Error('Workspace revocation has no existing ancestor')
      current = parent
    }
  }

  /**
   * Read a stored grant for inventory; use isAuthorized for effective permission.
   * Corruption is an actionable failure, never a grant.
   * @param workspace - Existing absolute workspace directory.
   * @returns The authorization, or undefined if no record exists.
   */
  find(workspace: string): WorkspaceWriteRecord | undefined {
    const canonical = this.canonical(workspace)
    let text: string
    try { text = readFileSync(this.recordPath(canonical), 'utf8') } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
    const record = recordSchema.parse(JSON.parse(text))
    if (record.workspace !== canonical) throw new Error('Workspace authorization does not match its record identity')
    return record
  }

  /**
   * Check whether a stored grant is usable, excluding incomplete revocations.
   * @param workspace - Existing absolute workspace directory.
   * @returns True only for an authorization without a durable revocation marker.
   */
  isAuthorized(workspace: string): boolean {
    if (process.platform === 'win32') {
      try { assertWindowsStateTrusted(this.recordPath(workspace), this.canonical(workspace)) } catch (error) {
        // A failed native check cannot authorize writes or prevent a read-only session.
        if (error instanceof Error) return false
        throw error
      }
    }
    return !this.revocationPending(this.recordPath(workspace)) && this.find(workspace) !== undefined
  }

  /**
   * Recheck durable consent and materialize a native capability under the revocation lock.
   * The operation must not recursively authorize or revoke the same workspace.
   * @param workspace - Existing absolute workspace directory.
   * @param operation - Native materialization, kept inside the record lock until settled.
   * @param signal - Cancellation while waiting or before native materialization.
   * @returns The materialized capability; rejects absent or interrupted authorization.
   */
  async withAuthorization<T>(workspace: string, operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    const canonical = this.canonical(workspace)
    const current = this.checkpoint(canonical)
    assertWindowsStateTrusted(this.directory, canonical)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const path = this.identityPath(canonical)
    return withFileLock(path, async () => {
      current()
      signal?.throwIfAborted()
      assertWindowsStateTrusted(path, canonical)
      if (!this.isAuthorized(canonical)) throw new Error('Workspace write authorization is absent or revoked')
      this.assertUnprotected(canonical)
      const result = await operation()
      current()
      return result
    }, signal === undefined ? {} : { signal })
  }

  private revocationPending(path: string): boolean {
    try { statSync(`${path}.revoking`) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
    return true
  }

  /**
   * Read the authorization inventory without materializing native permissions.
   * @returns Every stored authorization, sorted by canonical workspace.
   */
  list(): WorkspaceWriteRecord[] {
    let names: string[]
    try { names = readdirSync(this.directory) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    return names.filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).map((name) => {
      const record = recordSchema.parse(JSON.parse(readFileSync(join(this.directory, name), 'utf8')))
      const digest = createHash('sha256').update(record.workspace).digest('hex')
      if (name !== `${digest}.json` || !isAbsolute(record.workspace)) throw new Error('Invalid workspace authorization identity')
      return record
    }).sort((left, right) => left.workspace.localeCompare(right.workspace))
  }

  /**
   * Read interrupted revocations, including markers without an authorization record.
   * @returns Canonical recorded directories whose revocation still requires retry.
   */
  pendingRevocations(): string[] {
    let names: string[]
    try { names = readdirSync(this.directory) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    return names.filter(name => /^[a-f0-9]{64}\.json\.revoking$/u.test(name)).map((name) => {
      const marker = recordSchema.pick({ workspace: true }).parse(JSON.parse(readFileSync(join(this.directory, name), 'utf8')))
      const digest = createHash('sha256').update(marker.workspace).digest('hex')
      if (name !== `${digest}.json.revoking` || !isAbsolute(marker.workspace)) throw new Error('Invalid workspace revocation identity')
      return marker.workspace
    }).sort()
  }

  /**
   * Persist consent before a caller can obtain a writable policy. No ACL is changed here.
   * @param workspace - Existing absolute workspace directory.
   * @param source - Human confirmation or settings preauthorization.
   * @param signal - Cancellation before consent commits; prior consent is preserved on withdrawal.
   * @param current - Guard acquired before external capture; direct consent reads the generation under the record lock.
   * @returns The atomically committed authorization.
   */
  async authorize(workspace: string, source: WorkspaceWriteRecord['source'], signal?: AbortSignal,
    current?: () => void): Promise<WorkspaceWriteRecord> {
    current?.()
    const canonical = this.canonical(workspace)
    assertWindowsStateTrusted(this.directory, canonical)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const path = this.recordPath(canonical)
    return withFileLock(path, async () => {
      signal?.throwIfAborted()
      this.assertUnprotected(canonical)
      assertWindowsStateTrusted(path, canonical)
      if (this.revocationPending(path)) throw new WorkspaceWriteRuleError('Workspace revocation is incomplete; retry revocation before authorizing')
      if (current === undefined && this.issued.has(canonical)) {
        throw new WorkspaceWriteRuleError('Previously issued workspace capabilities have no completion proof; restart the host before reauthorizing. / 先前发出的工作区写能力没有完成证明；请重启宿主后再授权。')
      }
      // Direct consent carries no earlier capture; queued work keeps its supplied guard.
      const commitCurrent = current ?? this.checkpoint(canonical)
      commitCurrent()
      const record: WorkspaceWriteRecord = { workspace: canonical, grantedAt: new Date().toISOString(), source }
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' })
        let delay = 20
        for (let retries = 0;; retries++) {
          commitCurrent()
          signal?.throwIfAborted()
          try { renameSync(temporary, path); break } catch (error) {
            if (process.platform !== 'win32' || !(error instanceof Error) || !('code' in error)
              || !['EACCES', 'EBUSY', 'EPERM'].includes(String(error.code)) || retries >= 8) throw error
          }
          await wait(delay)
          delay = Math.min(delay * 2, 200)
        }
      } finally { await rm(temporary, { force: true }) }
      commitCurrent()
      return record
    }, signal === undefined ? {} : { signal })
  }

  /**
   * Persist a deny marker before native revocation, then remove the record and marker.
   * Any interrupted step blocks record-based writes and reauthorization until retry succeeds.
   * @param workspace - Existing legacy directory or exact recorded identity, including deleted directories.
   * @param revokeAcl - Provider-owned native revocation, which must throw on failure.
   * @returns After the native capability (if the directory exists), record, and marker are removed.
   */
  async revoke(workspace: string, revokeAcl: (workspace: string) => void): Promise<void> {
    await this.revokeCurrent(workspace, revokeAcl)
  }

  private async revokeCurrent(workspace: string, revokeAcl: (workspace: string) => void, current?: () => void): Promise<void> {
    const recorded = this.list().some(record => record.workspace === workspace) || this.pendingRevocations().includes(workspace)
    const canonical = recorded ? workspace : this.canonical(workspace)
    this.revocationTargetExists(canonical)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const path = this.identityPath(canonical)
    await withFileLock(path, async () => {
      // A rollback may have waited behind a newer owner grant.
      try { current?.() } catch (error) {
        if (!(error instanceof Error)) throw error
        return
      }
      this.advance(canonical)
      await writeFileAtomic(`${path}.revoking`, `${JSON.stringify({ workspace: canonical })}\n`, { mode: 0o600 })
      if (this.revocationTargetExists(canonical)) revokeAcl(canonical)
      await rm(path, { force: true })
      await rm(`${path}.revoking`, { force: true })
    })
  }
}
