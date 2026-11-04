/** Trusted Linux pre-exec migration and host registration acknowledgement. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LinuxLaunchFiles } from './runner-protocol.ts'

/**
 * Migrate this trusted runner before any target code, then wait for host registration.
 * @param files - Launch directory protected by the sandbox's unreadable-path policy.
 */
export function enterLinuxProductGroup(files: LinuxLaunchFiles): void {
  const membership = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(line => line.startsWith('0::/'))
  if (membership === undefined) throw new Error('Product sandbox requires unified cgroup membership')
  const parent = join('/sys/fs/cgroup', membership.slice(3))
  const group = join(parent, 'panedesk-product')
  mkdirSync(group)
  writeFileSync(join(group, 'cgroup.procs'), String(process.pid))
  const pending = join(files.directory, 'cgroup-ready.pending')
  writeFileSync(pending, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
  renameSync(pending, join(files.directory, 'cgroup-ready.json'))
  const deadline = Date.now() + 5000
  const wait = new Int32Array(new SharedArrayBuffer(4))
  while (!existsSync(join(files.directory, 'cgroup-ack'))) {
    if (Date.now() >= deadline) throw new Error('Product sandbox host registration timed out before exec')
    Atomics.wait(wait, 0, 0, 5)
  }
  if (readFileSync(join(files.directory, 'cgroup-ack'), 'utf8') !== 'registered\n') {
    throw new Error('Product sandbox host acknowledgement is invalid')
  }
}
