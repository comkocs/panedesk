/** 仅比较真源提供的完整改面；不以本地文件扫描补猜缺失证据。 */
import type { TaskScopeBatchGateContext, TaskScopeGateDecision, TaskScopeEntry } from '@panedesk/dsh-seat'

function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes(':')
    && !path.includes('\0') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
function overlaps(left: TaskScopeEntry, right: TaskScopeEntry, sensitive: boolean): boolean {
  if (left.access === 'read' && right.access === 'read') return false
  // 未证明 glob 的交集为空时必须保守冲突，不能用文本不等代替集合不相交。
  if (left.kind === 'pattern' || right.kind === 'pattern') return true
  const a = sensitive ? left.path : left.path.toLowerCase()
  const b = sensitive ? right.path : right.path.toLowerCase()
  return a === b || (left.kind === 'directory' && b.startsWith(`${a}/`))
    || (right.kind === 'directory' && a.startsWith(`${b}/`))
}

/** 全批预检仓身份、版本、节点、位、路径与读写交集。
 * @param context - 执行入口捕获的完整任务证据。
 * @returns 允许及证据版本，或整批拒绝并提供串行替代。
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
