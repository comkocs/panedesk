import { readFileSync } from 'node:fs'
import type { SubprocessIdentity } from './types.ts'

/** Read OS creation evidence without treating an unreadable PID as verified.
 * @param pid - owned direct child, never a process-name lookup.
 * @returns immutable observation; unsupported hosts retain only the PID.
 */
export function readProcessIdentity(pid: number): SubprocessIdentity {
  if (process.platform !== 'linux') return Object.freeze({ pid })
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    const processGroupId = Number(fields[2])
    const startIdentity = fields[19]
    const bootIdentity = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0
      || startIdentity === undefined || !/^\d+$/.test(startIdentity) || bootIdentity.length === 0) {
      return Object.freeze({ pid })
    }
    return Object.freeze({ pid, processGroupId, startIdentity, bootIdentity })
  } catch {
    return Object.freeze({ pid })
  }
}

/** Compare creation evidence, rejecting unknown identity and PID reuse.
 * @param expected - previously registered identity.
 * @param current - fresh observation, injectable for deterministic reuse coverage.
 * @returns whether both observations identify the same process incarnation.
 */
export function sameProcessIdentity(
  expected: SubprocessIdentity,
  current: SubprocessIdentity = readProcessIdentity(expected.pid),
): boolean {
  if (expected.pid !== current.pid) return false
  if (expected.startedAt !== undefined && current.startedAt !== undefined
    && expected.startIdentity !== undefined && current.startIdentity !== undefined
    && expected.bootIdentity === undefined && current.bootIdentity === undefined) {
    return expected.startedAt === current.startedAt && expected.startIdentity === current.startIdentity
  }
  return expected.pid === current.pid && expected.startIdentity !== undefined
    && expected.bootIdentity !== undefined && expected.startIdentity === current.startIdentity
    && expected.bootIdentity === current.bootIdentity
    && expected.processGroupId === current.processGroupId
}
