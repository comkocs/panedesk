/** Resolve both supplementary and primary group membership through the system name service. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** Enumerate all known users belonging to a group; unavailable or incomplete results reject.
 * @param gid - directory group identity.
 * @returns user identities from both membership sources.
 */
export async function readGroupMembers(gid: number): Promise<readonly number[]> {
  const options = { encoding: 'utf8' as const, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }
  const [group, passwd] = await Promise.all([
    execute('getent', ['group', String(gid)], options),
    execute('getent', ['passwd'], options),
  ])
  const groups = group.stdout.trim().split('\n')
  const fields = groups[0]?.split(':') ?? []
  const supplementary = fields[3]
  if (groups.length !== 1 || fields.length !== 4 || fields[2] !== String(gid) || supplementary === undefined) {
    throw new Error('Group membership is unavailable')
  }
  const users = new Map<string, { uid: number; gid: number }>()
  for (const line of passwd.stdout.trim().split('\n')) {
    const row = line.split(':')
    if (row.length !== 7 || !row[0] || !/^\d+$/.test(row[2] ?? '') || !/^\d+$/.test(row[3] ?? '')) {
      throw new Error('Primary group membership is unavailable')
    }
    users.set(row[0], { uid: Number(row[2]), gid: Number(row[3]) })
  }
  const members = [...users.values()].filter(user => user.gid === gid).map(user => user.uid)
  for (const name of supplementary.split(',').filter(Boolean)) {
    const user = users.get(name)
    if (!user) throw new Error('Supplementary group membership is unavailable')
    members.push(user.uid)
  }
  return members
}
