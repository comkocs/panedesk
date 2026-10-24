/** Private-file policy is replaceable by an account-scoped Windows ACL implementation. */
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Platform policy owns path traversal, account identity, ACLs and atomic durable publication. */
export interface PrivateFiles {
  /** Verify or create the owned directory; reject links and permissive access. */
  prepare(): Promise<void>
  /** Read a bounded regular file; missing files return null, unsafe files reject. */
  read(name: string, maxBytes: number): Promise<string | null>
  /** Publish owner-only bytes durably without following an existing link. */
  write(name: string, content: string): Promise<void>
  /** Remove an owned regular file, never a link target. */
  remove(name: string): Promise<void>
  /** Acquire exclusive ownership; abandoned locks require explicit operator recovery. */
  lock(): Promise<() => Promise<void>>
}

/** Linux policy checks the opened inode, not merely a pathname before opening. */
export class PosixPrivateFiles implements PrivateFiles {
  constructor(private readonly root: string, private readonly uid: number) {
    if (!isAbsolute(root) || process.platform === 'win32') throw new Error('Private file policy unavailable')
  }
  async prepare(): Promise<void> {
    await this.ancestors()
    await mkdir(this.root, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw new Error('Private directory unavailable')
    })
    const stat = await lstat(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid || (stat.mode & 0o777) !== 0o700) {
      throw new Error('Private directory ownership or permissions rejected')
    }
  }
  async lock(): Promise<() => Promise<void>> {
    await this.prepare()
    const handle = await open(this.path('owner.lock'), 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid }))
      await handle.sync()
    } catch (error) {
      await handle.close()
      await unlink(this.path('owner.lock'))
      throw error
    }
    return async () => { await handle.close(); await unlink(this.path('owner.lock')) }
  }
  private async ancestors(): Promise<void> {
    let path = dirname(this.root)
    for (;;) {
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private path rejected')
      if (path === parse(path).root) break
      path = dirname(path)
    }
  }
  private path(name: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw new Error('Private filename rejected')
    const path = join(this.root, name)
    if (relative(this.root, path) !== name) throw new Error('Private filename rejected')
    return path
  }
  async read(name: string, maxBytes: number): Promise<string | null> {
    await this.prepare()
    const handle = await open(this.path(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
        throw new Error('Private file unavailable')
      })
    if (handle === null) return null
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.uid !== this.uid || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > maxBytes) {
        throw new Error('Private file ownership or permissions rejected')
      }
      const bytes = Buffer.alloc(Math.min(stat.size, maxBytes) + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > maxBytes) throw new Error('Private file exceeds limit')
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
    } finally { await handle.close() }
  }
  async write(name: string, content: string): Promise<void> {
    await this.prepare()
    await this.read(name, 64 * 1024 * 1024)
    const temporary = this.path(`write-${randomBytes(16).toString('hex')}`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      await rename(temporary, this.path(name))
    } catch (error) { await unlink(temporary); throw error }
    const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY)
    try { await directory.sync() } finally { await directory.close() }
  }
  async remove(name: string): Promise<void> {
    if (await this.read(name, 64 * 1024 * 1024) !== null) await unlink(this.path(name))
  }
}
