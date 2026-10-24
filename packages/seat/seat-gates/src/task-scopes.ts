/** Compare only complete scopes supplied by the authority; local file scans never fill missing evidence. */
import type { TaskScopeBatchGateContext, TaskScopeGateDecision, TaskScopeEntry } from '@panedesk/dsh-seat'

function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes(':')
    && !path.includes('\0') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
function overlaps(left: TaskScopeEntry, right: TaskScopeEntry, sensitive: boolean): boolean {
  if (left.access === 'read' && right.access === 'read') return false
  // Treat unproven glob disjointness as a conflict; unequal text does not establish disjoint sets.
  if (left.kind === 'pattern' || right.kind === 'pattern') return true
  const a = sensitive ? left.path : left.path.toLowerCase()
  const b = sensitive ? right.path : right.path.toLowerCase()
  return a === b || (left.kind === 'directory' && b.startsWith(`${a}/`))
    || (right.kind === 'directory' && a.startsWith(`${b}/`))
}

/** Preflight repository identities, revisions, nodes, seats, paths and read/write intersections for the entire batch.
 * @param context - Complete task evidence captured at the execution entry.
 * @returns Approval with evidence revisions, or batch rejection with a serial alternative.
 */
export function checkTaskScopes(context: TaskScopeBatchGateContext): TaskScopeGateDecision {
  const deny = (reason: 'scope-unknown' | 'scope-conflict' | 'scope-stale', conflicts: Extract<TaskScopeGateDecision, { outcome: 'deny' }>['conflicts'] = []): TaskScopeGateDecision =>
    ({ outcome: 'deny', reason, alternative: 'serial', conflicts })
  const tasks = context.tasks
  if (!tasks.length || new Set(tasks.map(task => task.taskId)).size !== tasks.length
    || context.seats.some(seat => !tasks.some(task => task.seat === seat))) return deny('scope-unknown')
  for (const task of tasks) {
    const scope = task.scopeEvidence
    if (!context.seats.includes(task.seat) || task.nodeId !== context.nodeId || !task.scopeEvidenceRef
      || scope.taskId !== task.taskId || scope.status === 'unknown') return deny('scope-unknown')
    if (!scope.revision || !scope.repositoryId || !scope.baseRevision || !scope.entries.length
      || scope.entries.some(entry => !safePath(entry.path)
        || (scope.patternSyntax === 'literal' && entry.kind === 'pattern'))) return deny('scope-unknown')
  }
  for (let i = 0; i < tasks.length; i++) {
    const left = tasks[i]
    if (!left) return deny('scope-unknown')
    const a = left.scopeEvidence
    if (a.status !== 'known') return deny('scope-unknown')
    for (const right of tasks.slice(i + 1)) {
      const b = right.scopeEvidence
      if (b.status !== 'known') return deny('scope-unknown')
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
