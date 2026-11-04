/** Linux TCP socket cgroup queries through the host's stable Node-API addon. */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Client-direction TCP endpoints, taken from an accepted transport rather than request headers. */
export interface SocketCgroupTuple {
  sourceAddress: string
  sourcePort: number
  destinationAddress: string
  destinationPort: number
}

/** One loaded Linux binding; queries fail instead of guessing a process from its parent PID. */
export interface SocketCgroupQuery {
  /** @returns Whether this kernel exposes socket cgroup IDs; does not test user delegation. */
  probe(): boolean
  /**
   * Look up one TCP socket in the caller's network namespace within a bounded synchronous query.
   * @param tuple - Numeric client-direction endpoints of the socket.
   * @returns Kernel cgroup ID; throws when the socket or its cgroup cannot be identified.
   */
  query(tuple: SocketCgroupTuple): bigint
}

interface SocketCgroupBinding {
  probeSocketCgroup(): boolean
  querySocketCgroup(source: string, sourcePort: number, destination: string, destinationPort: number): bigint
}

/**
 * Load the Linux socket query capability without a module-global registry or environment override.
 * @returns Instance-owned query functions; unsupported platforms and missing addons throw.
 */
export function loadSocketCgroupQuery(): SocketCgroupQuery {
  if (process.platform !== 'linux') throw new Error('Socket cgroup queries require Linux')
  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
  const require = createRequire(import.meta.url)
  const manifest = require.resolve(`@panedesk/node-addon-system-linux-${process.arch}/package.json`)
  const binding = require(join(dirname(manifest), 'bin', report.header.glibcVersionRuntime ? 'glibc' : 'musl', 'system.node')) as SocketCgroupBinding
  return {
    probe: () => binding.probeSocketCgroup(),
    query: tuple => binding.querySocketCgroup(tuple.sourceAddress, tuple.sourcePort, tuple.destinationAddress, tuple.destinationPort),
  }
}
