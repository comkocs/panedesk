/** Explicit Windows private-file provider; POSIX policy and default assembly remain unchanged. */
import * as fs from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { win32 } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import type { PrivateFiles } from './private-files.ts'
import * as native from '@panedesk/node-addon-system/windows-private-files'
import { inspectWindowsPrivatePath, secureWindowsPrivatePath, replaceWindowsPrivatePath,
  type WindowsPrivateFilesExecutor } from './windows-private-files-system.ts'

/** Stable identifiers for Windows private-file policy refusals. */
export const WINDOWS_PRIVATE_FILE_CODES = {
  'Private absolute Windows path rejected': 'private-absolute-path',
  'Private filename rejected': 'private-filename',
  'Private reparse point rejected': 'private-reparse-point',
  'Private parent path rejected': 'private-parent-path',
  'Private owner SID rejected': 'private-owner-sid',
  'Private ACL inheritance rejected': 'private-acl-inheritance',
  'Private ACL entry count rejected': 'private-acl-entry-count',
  'Private ACL SID rejected': 'private-acl-sid',
  'Private ACL rights rejected': 'private-acl-rights',
  'Private directory type rejected': 'private-directory-type',
  'Private file type or links rejected': 'private-file-type-or-links',
  'Private file exceeds limit': 'private-file-exceeds-limit',
  'Private file identity rejected': 'private-file-identity',
} as const
/** A Windows private-file policy refusal identifier. */
export type WindowsPrivateFileCode = typeof WINDOWS_PRIVATE_FILE_CODES[keyof typeof WINDOWS_PRIVATE_FILE_CODES]

function rejected(message: keyof typeof WINDOWS_PRIVATE_FILE_CODES): Error & { readonly code: WindowsPrivateFileCode } {
  return Object.assign(new Error(message), { code: WINDOWS_PRIVATE_FILE_CODES[message] })
}

/** Injectable operating-system seams for server-side Windows policy tests. */
export interface WindowsPrivateFilesOptions {
  /** Legacy metadata-only test oracle; production never executes PowerShell. */
  execute?: WindowsPrivateFilesExecutor
  /** In-process Win32 operations; production uses the stable Node-API binding. */
  security?: Pick<typeof native, 'inspectWindowsPrivatePath' | 'secureWindowsPrivatePath' | 'replaceWindowsPrivatePath'>
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
  private readonly execute: WindowsPrivateFilesExecutor | undefined
  private readonly security: NonNullable<WindowsPrivateFilesOptions['security']>
  private readonly replace: NonNullable<WindowsPrivateFilesOptions['replace']>
  private readonly delay: NonNullable<WindowsPrivateFilesOptions['delay']>
  constructor(private readonly root: string, options: WindowsPrivateFilesOptions = {}) {
    if (!win32.isAbsolute(root) || !/^[a-zA-Z]:\\/.test(root) || root.includes('/')
      || root.slice(3).split('\\').some(part => /[<>:"|?*\u0000-\u001f]/.test(part) || /[ .]$/.test(part)
        || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
      throw rejected('Private absolute Windows path rejected')
    }
    this.filesystem = options.filesystem ?? fs
    this.execute = options.execute
    this.security = options.security ?? native
    this.delay = options.delay ?? (milliseconds => setTimeout(milliseconds))
    this.replace = options.replace ?? (async (source, target) => {
      const result = this.execute === undefined
        ? String(this.security.replaceWindowsPrivatePath(source, target))
        : await this.execute(replaceWindowsPrivatePath(source, target))
      if (result !== '0') throw Object.assign(new Error('Private replacement unavailable'), {
        code: result === '5' ? 'EPERM' : result === '32' || result === '33' ? 'EBUSY' : 'EIO',
      })
    })
  }
  private path(name: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || /[.]$/.test(name)
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) throw rejected('Private filename rejected')
    return win32.join(this.root, name)
  }
  private async inspect(path: string, acl: boolean, directory?: string): Promise<void> {
    const value: unknown = this.execute === undefined ? this.security.inspectWindowsPrivatePath(path, directory)
      : JSON.parse(await this.execute(inspectWindowsPrivatePath(path, directory)))
    this.validate(value, acl)
    if (directory !== undefined) this.validate(object(value) ? value.directory : undefined, true)
  }
  private validate(value: unknown, acl: boolean): void {
    if (!object(value) || value.reparse !== false) throw rejected('Private reparse point rejected')
    if (value.parents !== true) throw rejected('Private parent path rejected')
    if (!acl) return
    if (typeof value.sid !== 'string' || !/^S-1-\d+(?:-\d+)+$/.test(value.sid) || value.owner !== value.sid) {
      throw rejected('Private owner SID rejected')
    }
    if (value.protected !== true) throw rejected('Private ACL inheritance rejected')
    if (!Array.isArray(value.rules) || value.rules.length !== 1) throw rejected('Private ACL entry count rejected')
    const rule: unknown = value.rules[0]
    if (!object(rule) || rule.sid !== value.sid) throw rejected('Private ACL SID rejected')
    if (rule.inherited !== false) throw rejected('Private ACL inheritance rejected')
    if (rule.allow !== true || rule.rights !== 2032127 || rule.propagation !== 0) throw rejected('Private ACL rights rejected')
  }
  private async existingDirectory(): Promise<boolean> {
    let stat
    try { stat = await this.filesystem.lstat(this.root) }
    catch (error) { if (code(error, 'ENOENT')) return false; throw error }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw rejected('Private directory type rejected')
    return true
  }
  async prepare(): Promise<void> {
    if (await this.existingDirectory()) { await this.inspect(this.root, true); return }
    const parent = win32.dirname(this.root)
    await this.inspect(parent, false)
    if (!(await this.filesystem.lstat(parent)).isDirectory()) throw rejected('Private parent path rejected')
    let created = false
    try { await this.filesystem.mkdir(this.root); created = true }
    catch (error) { if (!code(error, 'EEXIST')) throw error }
    try {
      const stat = await this.filesystem.lstat(this.root)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw rejected('Private directory type rejected')
      if (created) await this.secure(this.root, true)
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
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw rejected('Private file type or links rejected')
    if (stat.size > maxBytes) throw rejected('Private file exceeds limit')
    const handle = await this.filesystem.open(path, 'r')
    try {
      await this.inspect(path, true, this.root)
      const opened = await handle.stat(), named = await this.filesystem.lstat(path)
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino
        || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1
        || named.dev !== opened.dev || named.ino !== opened.ino) {
        throw rejected('Private file identity rejected')
      }
      if (opened.size > maxBytes) throw rejected('Private file exceeds limit')
      return handle
    } catch (error) { await handle.close(); throw error }
  }
  async read(name: string, maxBytes: number): Promise<string | null> {
    const path = this.path(name)
    if (!await this.existingDirectory()) await this.prepare()
    const handle = await this.checked(path, maxBytes)
    if (handle === null) { await this.inspect(this.root, true); return null }
    try {
      const chunks: Buffer[] = []
      let total = 0
      for (;;) {
        const chunk = Buffer.alloc(64 * 1024)
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > maxBytes) throw rejected('Private file exceeds limit')
        chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead))
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    } finally { await handle.close() }
  }
  private async secure(path: string, directory: boolean): Promise<void> {
    if (this.execute === undefined) this.security.secureWindowsPrivatePath(path)
    else await this.execute(secureWindowsPrivatePath(path, directory))
  }
  private async create(path: string, content: string): Promise<fs.FileHandle> {
    const handle = await this.filesystem.open(path, 'wx')
    try {
      await this.secure(path, false)
      await this.inspect(path, true)
      const stat = await handle.stat(), named = await this.filesystem.lstat(path)
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== named.ino || stat.dev !== named.dev) {
        throw rejected('Private file identity rejected')
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
