/** Product-home authorization records; one atomic file per canonical workspace avoids lost sibling updates. */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { withFileLock, writeFileAtomic } from '@panedesk/dsh-atomic-write'

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

  /** @param home - Resolved product home, never the current workspace. */
  constructor(home: string) {
    this.directory = join(home, 'windows-workspace-write')
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
    return !this.revocationPending(this.recordPath(workspace)) && this.find(workspace) !== undefined
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
   * @returns The atomically committed authorization.
   */
  async authorize(workspace: string, source: WorkspaceWriteRecord['source'], signal?: AbortSignal): Promise<WorkspaceWriteRecord> {
    const canonical = this.canonical(workspace)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const path = this.recordPath(canonical)
    return withFileLock(path, async () => {
      signal?.throwIfAborted()
      if (this.revocationPending(path)) throw new Error('Workspace revocation is incomplete; retry revocation before authorizing')
      const previous = this.find(canonical)
      const record: WorkspaceWriteRecord = { workspace: canonical, grantedAt: new Date().toISOString(), source }
      await writeFileAtomic(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      if (signal?.aborted) {
        if (previous === undefined) await rm(path, { force: true })
        else await writeFileAtomic(path, `${JSON.stringify(previous)}\n`, { mode: 0o600 })
        signal.throwIfAborted()
      }
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
    const recorded = this.list().some(record => record.workspace === workspace) || this.pendingRevocations().includes(workspace)
    const canonical = recorded ? workspace : this.canonical(workspace)
    this.revocationTargetExists(canonical)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const path = this.identityPath(canonical)
    await withFileLock(path, async () => {
      await writeFileAtomic(`${path}.revoking`, `${JSON.stringify({ workspace: canonical })}\n`, { mode: 0o600 })
      if (this.revocationTargetExists(canonical)) revokeAcl(canonical)
      await rm(path, { force: true })
      await rm(`${path}.revoking`, { force: true })
    })
  }
}
