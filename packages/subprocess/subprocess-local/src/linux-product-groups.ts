/** Host-owned product cgroup registrations, independent of connection-plugin reloads. */
import { constants, accessSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { Context, Service } from '@panedesk/cordis'
import { loadSocketCgroupQuery, type SocketCgroupQuery } from '@panedesk/node-addon-system/socket-cgroup'
import type { ConnectionSource, ConnectionSourceSocket } from '@panedesk/dsh-client-connection'
import type { LinuxLaunchFiles } from './runner-protocol.ts'

/** Visible warning when the host cannot identify product-sandbox network connections. */
export const LINUX_SOURCE_LIMITATION = 'Known limitation: Linux sandbox connection sources cannot be distinguished; a valid owner cookie can still be replayed. Enable cgroup v2 user-session delegation or run untrusted processes as a separate user. / 已知限制：Linux 无法区分沙箱连接来源；有效 owner cookie 仍可被回放。请启用 cgroup v2 用户会话委派，或以不同用户运行不可信进程。'

function currentGroup(pid: number | 'self'): string {
  const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find(line => line.startsWith('0::/'))
  if (line === undefined) throw new Error('Unified cgroup membership is unavailable')
  return join('/sys/fs/cgroup', line.slice(3))
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

declare module '@panedesk/cordis' {
  interface Context {
    /** Root-owned Linux identities retained across provider and transport reloads. */
    linuxProductGroupOwner: LinuxProductGroupOwner
  }
}

class LinuxProductGroupOwner extends Service {
  readonly groups = LinuxProductGroups.probe()

  constructor(ctx: Context) { super(ctx, 'linuxProductGroupOwner') }
}

/** Host-lifetime product identities; process cleanup does not establish socket closure. */
export class LinuxProductGroups {
  private readonly groups = new Map<string, bigint>()
  private readonly retired = new Set<bigint>()
  // Evicted identities remain deny-only even if the kernel later reuses a full ID.
  // False positives lose owner admission, never product startup or confinement.
  private readonly evicted = Buffer.alloc(1024 * 1024)

  private identityBits(identity: bigint): number[] {
    const bits: number[] = []
    let hash = BigInt.asUintN(64, identity)
    for (let index = 0; index < 4; index++) {
      hash = BigInt.asUintN(64, (hash ^ (hash >> 30n)) * 0xbf58476d1ce4e5b9n)
      hash = BigInt.asUintN(64, (hash ^ (hash >> 27n)) * 0x94d049bb133111ebn)
      hash ^= hash >> 31n
      bits.push(Number(hash & 0x7fffffn))
    }
    return bits
  }

  private remember(identity: bigint): void {
    this.retired.add(identity)
    if (this.retired.size <= 4096) return
    const oldest = this.retired.values().next().value
    if (oldest === undefined) return
    for (const bit of this.identityBits(oldest)) {
      const byte = bit >>> 3
      this.evicted.writeUInt8(this.evicted.readUInt8(byte) | (1 << (bit & 7)), byte)
    }
    this.retired.delete(oldest)
  }

  /**
   * Reuse the root-owned identity set across subprocess-provider reloads.
   * @param ctx - Provider context whose root owns the server lifetime.
   * @returns The host's capable registry, or undefined when its startup probe failed.
   */
  static forHost(ctx: Context): LinuxProductGroups | undefined {
    const owner = ctx.root.get('linuxProductGroupOwner') ?? new LinuxProductGroupOwner(ctx.root)
    return owner.groups
  }

  private constructor(private readonly query: SocketCgroupQuery) {}

  /**
   * Probe kernel socket attribution separately from filesystem delegation.
   * @returns A capable registry, or undefined without changing system configuration.
   */
  static probe(): LinuxProductGroups | undefined {
    try {
      const query = loadSocketCgroupQuery()
      if (!query.probe()) return undefined
      const group = currentGroup('self')
      accessSync(join(group, 'cgroup.procs'), constants.W_OK)
      accessSync(group, constants.W_OK)
      const child = mkdtempSync(join(group, 'dsh-attribution-probe-'))
      try { accessSync(join(child, 'cgroup.procs'), constants.W_OK) }
      finally { rmdirSync(child) }
      return new LinuxProductGroups(query)
    } catch (_unavailable) {
      // Missing native support or delegation is a documented startup limitation.
      return undefined
    }
  }

  /**
   * Classify an accepted socket using the client direction of its physical tuple.
   * @param socket - Accepted transport, never request headers.
   * @returns Product, non-product, or unknown on any unavailable observation.
   */
  classify(socket: ConnectionSourceSocket | undefined): ConnectionSource {
    if (socket?.remoteAddress === undefined || socket.remotePort === undefined
      || socket.localAddress === undefined || socket.localPort === undefined) return 'unknown'
    try {
      const mapped = socket.remoteAddress.startsWith('::ffff:') && socket.localAddress.startsWith('::ffff:')
      const id = this.query.query({
        sourceAddress: mapped ? socket.remoteAddress.slice(7) : socket.remoteAddress,
        sourcePort: socket.remotePort,
        destinationAddress: mapped ? socket.localAddress.slice(7) : socket.localAddress,
        destinationPort: socket.localPort,
      })
      if (this.retired.has(id)) return 'product-sandbox'
      const possiblyEvicted = this.identityBits(id).every(bit => (this.evicted.readUInt8(bit >>> 3) & (1 << (bit & 7))) !== 0)
      let visited = 0
      const contains = (path: string): boolean => {
        if (++visited > 4096) throw new Error('Product cgroup traversal exceeds admission bound')
        if (statSync(path, { bigint: true }).ino === id) return true
        return readdirSync(path, { withFileTypes: true }).some(entry => entry.isDirectory() && contains(join(path, entry.name)))
      }
      for (const [path, registered] of this.groups) {
        if (registered === id) return 'product-sandbox'
        if (contains(path)) return 'product-sandbox'
      }
      // An unlinked cgroup can still own a transferred socket. Only a currently
      // visible, non-product cgroup establishes the permissive classification.
      return !possiblyEvicted && contains('/sys/fs/cgroup') ? 'non-product' : 'unknown'
    } catch (_unverifiable) {
      // A capable host never turns a failed per-connection query into permission.
      return 'unknown'
    }
  }

  /**
   * Wait for the trusted bootstrap to migrate, register it, then acknowledge permission to exec.
   * @param files - Private launch artifacts inaccessible to product sandboxes.
   * @param unit - Exact transient scope owned by this launch.
   * @returns Cleanup after the managed range is positively observed empty.
   */
  prepare(files: LinuxLaunchFiles, unit: string): () => void {
    const ready = join(files.directory, 'cgroup-ready.json')
    const ack = join(files.directory, 'cgroup-ack')
    let registeredPath: string | undefined
    const deadline = Date.now() + 5000
    const timer = setInterval(() => {
      if (Date.now() >= deadline) { clearInterval(timer); return }
      if (!existsSync(ready)) return
      try {
        const value: unknown = JSON.parse(readFileSync(ready, 'utf8'))
        if (value === null || typeof value !== 'object' || !('pid' in value)
          || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
          throw new Error('Invalid product cgroup readiness record')
        }
        const path = currentGroup(value.pid)
        if (!path.endsWith(`/${unit}/panedesk-product`) || dirname(path).split('/').at(-1) !== unit) {
          throw new Error('Product bootstrap is outside its owned scope')
        }
        const id = statSync(path, { bigint: true }).ino
        this.groups.set(path, id)
        registeredPath = path
        const pending = join(files.directory, 'cgroup-ack.pending')
        writeFileSync(pending, 'registered\n', { flag: 'wx', mode: 0o600 })
        renameSync(pending, ack)
      } catch (_invalidReadiness) {
        // No acknowledgement: the bootstrap times out without executing its target.
      }
      clearInterval(timer)
    }, 5)
    return () => {
      clearInterval(timer)
      if (registeredPath === undefined) return
      const path = registeredPath
      const identity = this.groups.get(path)
      if (identity !== undefined) this.remember(identity)
      try {
        if (!/^populated 0$/m.test(readFileSync(join(path, 'cgroup.events'), 'utf8'))) {
          throw new Error('Cannot release a populated product cgroup')
        }
        const remove = (directory: string): void => {
          this.remember(statSync(directory, { bigint: true }).ino)
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.isDirectory()) remove(join(directory, entry.name))
          }
          rmdirSync(directory)
        }
        remove(path)
      } catch (error) { if (!missing(error)) throw error }
      this.groups.delete(path)
    }
  }
}
