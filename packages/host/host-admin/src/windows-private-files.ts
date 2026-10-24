/** Explicit Windows private-file provider; POSIX policy and default assembly remain unchanged. */
import * as fs from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { win32 } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import type { PrivateFiles } from './private-files.ts'
import { executeWindowsPrivateFiles, inspectWindowsPrivatePath, secureWindowsPrivatePath, replaceWindowsPrivatePath,
  type WindowsPrivateFilesExecutor } from './windows-private-files-system.ts'

/** Injectable operating-system seams for server-side Windows policy tests. */
export interface WindowsPrivateFilesOptions {
  /** Metadata-only PowerShell executor; no file contents cross this interface. */
  execute?: WindowsPrivateFilesExecutor
  /** File operations; production uses Node's filesystem implementation. */
  filesystem?: {
    lstat: (path: string) => Promise<Stats>
    mkdir: (path: string) => Promise<unknown>
    rmdir: (path: string) => Promise<void>
    open: (path: string, flags: string) => Promise<fs.FileHandle>
    unlink: (path: string) => Promise<void>
  }
  /** Same-directory write-through replacement; production uses MoveFileExW. */
  replace?: (source: string, target: string) => Promise<void>
  /** Bounded contention backoff; production uses asynchronous timers. */
  delay?: (milliseconds: number) => Promise<void>
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function code(error: unknown, expected: string): boolean {
  return error instanceof Error && 'code' in error && error.code === expected
}

/** Current-user-only Windows DACLs; existing permissions are never repaired or broadened. */
export class WindowsPrivateFiles implements PrivateFiles {
  private readonly filesystem: NonNullable<WindowsPrivateFilesOptions['filesystem']>
  private readonly execute: WindowsPrivateFilesExecutor
  private readonly replace: NonNullable<WindowsPrivateFilesOptions['replace']>
  private readonly delay: NonNullable<WindowsPrivateFilesOptions['delay']>
  constructor(private readonly root: string, options: WindowsPrivateFilesOptions = {}) {
    if (!win32.isAbsolute(root) || !/^[a-zA-Z]:\\/.test(root) || root.includes('/')
      || root.slice(3).split('\\').some(part => /[<>:"|?*\u0000-\u001f]/.test(part) || /[ .]$/.test(part)
        || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
      throw new Error('Private absolute Windows path rejected')
    }
    this.filesystem = options.filesystem ?? fs
    this.execute = options.execute ?? executeWindowsPrivateFiles
    this.delay = options.delay ?? (milliseconds => setTimeout(milliseconds))
    this.replace = options.replace ?? (async (source, target) => {
      const result = await this.execute(replaceWindowsPrivatePath(source, target))
      if (result !== '0') throw Object.assign(new Error('Private replacement unavailable'), {
        code: result === '5' ? 'EPERM' : result === '32' || result === '33' ? 'EBUSY' : 'EIO',
      })
    })
  }
  private path(name: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || /[.]$/.test(name)
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) throw new Error('Private filename rejected')
    return win32.join(this.root, name)
  }
  private async inspect(path: string, acl: boolean): Promise<void> {
    const value: unknown = JSON.parse(await this.execute(inspectWindowsPrivatePath(path)))
    if (!object(value) || value.reparse !== false) throw new Error('Private reparse point rejected')
    if (value.parents !== true) throw new Error('Private parent path rejected')
    if (!acl) return
    if (typeof value.sid !== 'string' || !/^S-1-\d+(?:-\d+)+$/.test(value.sid) || value.owner !== value.sid) {
      throw new Error('Private owner SID rejected')
    }
    if (value.protected !== true) throw new Error('Private ACL inheritance rejected')
    if (!Array.isArray(value.rules) || value.rules.length !== 1) throw new Error('Private ACL entry count rejected')
    const rule: unknown = value.rules[0]
    if (!object(rule) || rule.sid !== value.sid) throw new Error('Private ACL SID rejected')
    if (rule.inherited !== false) throw new Error('Private ACL inheritance rejected')
    if (rule.allow !== true || rule.rights !== 2032127 || rule.propagation !== 0) throw new Error('Private ACL rights rejected')
  }
  async prepare(): Promise<void> {
    const parent = win32.dirname(this.root)
    await this.inspect(parent, false)
    if (!(await this.filesystem.lstat(parent)).isDirectory()) throw new Error('Private parent path rejected')
    let created = false
    try { await this.filesystem.mkdir(this.root); created = true }
    catch (error) { if (!code(error, 'EEXIST')) throw error }
    try {
      const stat = await this.filesystem.lstat(this.root)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private directory type rejected')
      if (created) await this.execute(secureWindowsPrivatePath(this.root, true))
      await this.inspect(this.root, true)
    } catch (error) {
      if (created) await this.filesystem.rmdir(this.root)
      throw error
    }
  }
  private async checked(path: string, maxBytes: number): Promise<fs.FileHandle | null> {
    let stat
    try { stat = await this.filesystem.lstat(path) }
    catch (error) { if (code(error, 'ENOENT')) return null; throw error }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Private file type or links rejected')
    if (stat.size > maxBytes) throw new Error('Private file exceeds limit')
    await this.inspect(path, true)
    const handle = await this.filesystem.open(path, 'r')
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) {
        throw new Error('Private file identity rejected')
      }
      if (opened.size > maxBytes) throw new Error('Private file exceeds limit')
      await this.inspect(path, true)
      return handle
    } catch (error) { await handle.close(); throw error }
  }
  async read(name: string, maxBytes: number): Promise<string | null> {
    const path = this.path(name)
    await this.prepare()
    const handle = await this.checked(path, maxBytes)
    if (handle === null) return null
    try {
      const stat = await handle.stat()
      const bytes = Buffer.alloc(Math.min(stat.size, maxBytes) + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > maxBytes) throw new Error('Private file exceeds limit')
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))
    } finally { await handle.close() }
  }
  private async create(path: string, content: string): Promise<fs.FileHandle> {
    const handle = await this.filesystem.open(path, 'wx')
    try {
      await this.execute(secureWindowsPrivatePath(path, false))
      await this.inspect(path, true)
      const stat = await handle.stat(), named = await this.filesystem.lstat(path)
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== named.ino || stat.dev !== named.dev) {
        throw new Error('Private file identity rejected')
      }
      await handle.writeFile(content, 'utf8')
      await handle.sync()
      return handle
    } catch (error) {
      await handle.close()
      await this.filesystem.unlink(path)
      throw error
    }
  }
  async write(name: string, content: string): Promise<void> {
    const target = this.path(name)
    await this.read(name, 64 * 1024 * 1024)
    const temporary = this.path(`write-${randomBytes(16).toString('hex')}`)
    const handle = await this.create(temporary, content)
    try {
      await handle.close()
      for (let attempt = 0; ; attempt++) {
        await this.inspect(this.root, true)
        const previous = await this.checked(target, 64 * 1024 * 1024)
        await previous?.close()
        await this.inspect(temporary, true)
        try { await this.replace(temporary, target); break }
        catch (error) {
          if (attempt === 4 || (!code(error, 'EPERM') && !code(error, 'EBUSY'))) throw error
          await this.delay(Math.min(10 * 2 ** attempt, 40))
        }
      }
    } catch (error) { await this.filesystem.unlink(temporary); throw error }
  }
  async remove(name: string): Promise<void> {
    if (await this.read(name, 64 * 1024 * 1024) !== null) await this.filesystem.unlink(this.path(name))
  }
  async lock(): Promise<() => Promise<void>> {
    await this.prepare()
    const path = this.path('owner.lock')
    const handle = await this.create(path, JSON.stringify({ pid: process.pid }))
    return async () => {
      await handle.close()
      await this.remove('owner.lock')
    }
  }
}
