/** Deterministic DACL write/delete subset for the Windows owner-transport tests. */
import { writeFileSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { revokeWorkspaceTree } from '../../../sandbox/sandbox-windows-acl/src/revoke-tree.ts'

type Access = 'read' | 'write' | 'append' | 'write-ea' | 'write-attributes' | 'delete' | 'delete-child' | 'write-dac' | 'write-owner'
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
    return this.permitsSids(path, [sid], right)
  }

  /** Evaluate a complete enabled/restricting SID set rather than one trustee. */
  permitsSids(path: string, sids: readonly string[], right: Access, ownerBaseline = false): boolean {
    const applicable = this.entries.flatMap((entry) => {
      if (!sids.includes(entry.sid) || !entry.rights.includes(right)) return []
      const suffix = relative(entry.path, path)
      if (suffix === '') return [{ entry, depth: 0 }]
      if (!entry.recursive || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) return []
      return [{ entry, depth: suffix.split(sep).length }]
    }).sort((left, right) => left.depth - right.depth || Number(right.entry.deny) - Number(left.entry.deny))
    return applicable.length === 0 ? ownerBaseline : applicable[0]?.entry.deny === false
  }

  /** Match WRITE_RESTRICTED: ordinary access and restricting-list access must both grant writes. */
  permitsToken(path: string, capabilities: readonly string[], mask: number): boolean {
    const rights = new Map<number, Access>([
      [1, 'read'], [2, 'write'], [4, 'append'], [0x10, 'write-ea'], [0x100, 'write-attributes'],
      [0x10000, 'delete'], [0x40, 'delete-child'], [0x40000, 'write-dac'], [0x80000, 'write-owner'],
    ])
    const right = rights.get(mask)
    if (right === undefined) throw new Error(`Unsupported fixture access mask: ${mask}`)
    const ambient = ['S-1-1-0', 'S-1-5-5-1-2']
    // Owner access is ambient in this fixture; capabilities only participate
    // in the restricting pass, exactly as in the native token constructor.
    const ordinary = this.permitsSids(path, ['S-1-5-21-1', ...ambient], right, true)
    return ordinary && this.permitsSids(path, [...ambient, ...capabilities], right)
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
    windowsAcl.entries.push({ path, sid: this.sid, deny: false, recursive: true, rights: ['write', 'append', 'delete', 'delete-child'] })
  }
  protect(path: string, recursive = true): void {
    windowsAcl.entries.push({ path, sid: this.sid, deny: true, recursive, rights: recursive ? ['write', 'append', 'delete', 'delete-child'] : ['delete'] })
  }
  has(path: string): boolean { return windowsAcl.entries.some(entry => entry.path === path && entry.sid === this.sid && !entry.deny) }
  hasEffectiveWrite(path: string): boolean {
    return [2, 4, 0x10, 0x100, 0x10000, 0x40, 0x40000, 0x80000].some(mask => windowsAcl.permitsToken(path, [this.sid], mask))
  }
  revoke(path: string): void {
    for (let index = windowsAcl.entries.length - 1; index >= 0; index--) {
      const entry = windowsAcl.entries[index]
      if (entry?.path === path && entry.sid === this.sid) windowsAcl.entries.splice(index, 1)
    }
  }
  revokeTree(root: string): void {
    revokeWorkspaceTree(root, {
      hasExplicit: path => windowsAcl.entries.some(entry => entry.path === path && entry.sid === this.sid),
      removeExplicit: (path) => { this.revoke(path) },
      permits: (path, mask) => windowsAcl.permitsToken(path, [this.sid], mask),
    })
  }
  dispose(): void {}
}
