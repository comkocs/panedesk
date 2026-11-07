/** Compare known task scopes without blocking batches on missing evidence. */
import type { TaskScopeBatchGateContext, TaskScopeGateDecision, TaskScopeEntry } from '@panedesk/dsh-seat'

function overlaps(left: TaskScopeEntry, right: TaskScopeEntry, sensitive: boolean): boolean {
  if (left.access === 'read' && right.access === 'read') return false
  // Treat unproven glob disjointness as a conflict; unequal text does not establish disjoint sets.
  if (left.kind === 'pattern' || right.kind === 'pattern') return true
  const a = sensitive ? left.path : left.path.toLowerCase()
  const b = sensitive ? right.path : right.path.toLowerCase()
  return a === b || (left.kind === 'directory' && b.startsWith(`${a}/`))
    || (right.kind === 'directory' && a.startsWith(`${b}/`))
}

/** Preflight known repository revisions and read/write intersections for the batch.
 * @param context - Task evidence captured at the execution entry.
 * @returns Approval with known evidence revisions, or conflict rejection with a serial alternative.
 */
export function checkTaskScopes(context: TaskScopeBatchGateContext): TaskScopeGateDecision {
  const deny = (reason: 'scope-conflict' | 'scope-stale', conflicts: Extract<TaskScopeGateDecision, { outcome: 'deny' }>['conflicts'] = []): TaskScopeGateDecision =>
    ({ outcome: 'deny', reason, alternative: 'serial', conflicts })
  const tasks = context.tasks
  for (const [i, left] of tasks.entries()) {
    const a = left.scopeEvidence
    if (a.status !== 'known') continue
    for (const right of tasks.slice(i + 1)) {
      const b = right.scopeEvidence
      if (b.status !== 'known') continue
      if (a.repositoryId !== b.repositoryId) continue
      if (a.baseRevision !== b.baseRevision || a.caseSensitive !== b.caseSensitive) return deny('scope-stale')
      const paths = a.entries.flatMap(entry => b.entries.filter(other => overlaps(entry, other, a.caseSensitive))
        .flatMap(other => [entry.path, other.path]))
      if (paths.length) return deny('scope-conflict', [{ tasks: [left.taskId, right.taskId],
        repositoryId: a.repositoryId, paths: [...new Set(paths)] }])
    }
  }
  return { outcome: 'allow', revisions: tasks.flatMap(task => task.scopeEvidence.status === 'known'
    ? [{ taskId: task.taskId, revision: task.scopeEvidence.revision }] : []) }
}
