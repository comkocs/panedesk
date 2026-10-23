/** Read-only Git facts use an injected bounded executor and an explicitly resolved repository. */
import type { SeatWorktreeRegistration } from '@panedesk/dsh-seat'
import type { WorktreeEvidence } from './worktree.ts'

/** The host supplies argv execution under its filesystem and process policy. */
export type GitReader = (cwd: string, args: readonly string[]) => Promise<{ code: number; stdout: string; complete: boolean }>

/** Verify registration, merge ancestry and tracked cleanliness without guessing last activity.
 * @param read - bounded read-only Git executor; never a shell command string.
 * @param repository - host-resolved repository path, not an unverified repository ID.
 * @param target - explicit merge target owned by repository configuration.
 * @param tree - proposed registration.
 * @param lastChangedAt - durable observed activity or null when unavailable.
 * @returns conservative facts; incomplete output cannot establish eligibility.
 */
export async function inspectWorktree(
  read: GitReader, repository: string, target: string, tree: SeatWorktreeRegistration, lastChangedAt: number | null,
): Promise<WorktreeEvidence> {
  const unknown: WorktreeEvidence = { verified: false, merged: false, trackedClean: false, lastChangedAt: null }
  const listed = await read(repository, ['worktree', 'list', '--porcelain', '-z'])
  if (listed.code !== 0 || !listed.complete) return unknown
  const entries = listed.stdout.split('\0\0').map(record => record.split('\0'))
  const matched = entries.some(fields => fields.includes(`worktree ${tree.path}`)
    && fields.includes(`branch refs/heads/${tree.branch}`))
  if (!matched) return unknown
  const status = await read(tree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=no'])
  const merge = await read(tree.path, ['merge-base', '--is-ancestor', 'HEAD', target])
  return { verified: true, merged: merge.complete && merge.code === 0,
    trackedClean: status.complete && status.code === 0 && status.stdout.length === 0, lastChangedAt }
}
