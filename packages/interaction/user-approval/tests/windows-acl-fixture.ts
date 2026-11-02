/** Deterministic DACL write/delete subset for the Windows owner-transport tests. */
import { writeFileSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

type Access = 'write' | 'delete'
interface Entry {
  path: string
  sid: string
  deny: boolean
  recursive: boolean
  rights: readonly Access[]
}

/** Canonical explicit ACEs precede inherited ACEs; inheritance is nearest-ancestor first. */
export class WindowsAclFixture {
  readonly entries: Entry[] = []
  readonly additions: string[] = []
  beforeAdd: (path: string) => void = () => {}

  /** Reset between isolated owner sessions. */
  reset(): void {
    this.entries.length = 0
    this.additions.length = 0
    this.beforeAdd = () => {}
  }

  /**
   * Evaluate one right using Microsoft's DACL access-check and canonical ACE ordering.
   * @param path Object whose DACL is checked.
   * @param sid Restricting workspace SID.
   * @param right Requested write or delete right.
   * @returns Whether the first applicable ACE grants the right; absence denies.
   */
  permits(path: string, sid: string, right: Access): boolean {
    const applicable = this.entries.flatMap((entry) => {
      if (entry.sid !== sid || !entry.rights.includes(right)) return []
      const suffix = relative(entry.path, path)
      if (suffix === '') return [{ entry, depth: 0 }]
      if (!entry.recursive || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) return []
      return [{ entry, depth: suffix.split(sep).length }]
    }).sort((left, right) => left.depth - right.depth || Number(right.entry.deny) - Number(left.entry.deny))
    return applicable[0]?.entry.deny === false
  }

  /**
   * Execute a file write using the actual provider's handed-off mode and capability.
   * @param argv Windows runner arguments produced by LocalSandboxProvider.
   * @param path Destination filename.
   * @param content File contents.
   */
  write(argv: readonly string[], path: string, content: string): void {
    const mode = argv[argv.indexOf('--mode') + 1]
    const sid = argv[argv.indexOf('--write-sid') + 1]
    if (mode !== 'workspace-write' || sid === undefined || !this.permits(path, sid, 'write')) {
      throw new Error('ACL access denied')
    }
    writeFileSync(path, content)
  }
}

/** Shared only by this test module and its mocked native grant boundary. */
export const windowsAcl = new WindowsAclFixture()

/** Native capability substitute; policy, consent records and provider remain real. */
export class FixtureAclWriteGrant {
  constructor(private readonly sid: string) {}
  static create(sid: string): FixtureAclWriteGrant { return new FixtureAclWriteGrant(sid) }
  add(path: string): void {
    windowsAcl.beforeAdd(path)
    windowsAcl.additions.push(path)
    windowsAcl.entries.push({ path, sid: this.sid, deny: false, recursive: true, rights: ['write', 'delete'] })
  }
  protect(path: string, recursive = true): void {
    windowsAcl.entries.push({ path, sid: this.sid, deny: true, recursive, rights: recursive ? ['write', 'delete'] : ['delete'] })
  }
  has(path: string): boolean { return windowsAcl.entries.some(entry => entry.path === path && entry.sid === this.sid && !entry.deny) }
  revoke(path: string): void {
    for (let index = windowsAcl.entries.length - 1; index >= 0; index--) {
      const entry = windowsAcl.entries[index]
      if (entry?.path === path && entry.sid === this.sid) windowsAcl.entries.splice(index, 1)
    }
  }
  dispose(): void {}
}
