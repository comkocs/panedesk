/** 批闸不把未知或无法证明分离的改面当作空集合。 */
import { expect, it } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { checkTaskScopes } from '../src/task-scopes.ts'
function task(id: string, path: string, overrides: Partial<Extract<T.TaskScopeEvidence, { status: 'known' }>> = {}): T.SeatTaskScopeContext {
  const taskId = id as T.SeatTaskId
  return { taskId, seat: id as T.SeatName, nodeId: 'node-a' as T.SeatNodeId,
    scopeEvidenceRef: `scope:${id}` as T.SeatTaskScopeContext['scopeEvidenceRef'], scopeEvidence: {
      status: 'known', taskId, revision: '1', repositoryId: 'repo-a' as T.TaskRepositoryId, baseRevision: 'base-a',
      entries: [{ kind: 'file', path, access: 'write' }], patternSyntax: 'literal', caseSensitive: true, ...overrides } }
}
function check(tasks: T.SeatTaskScopeContext[]) {
  return checkTaskScopes({ hook: 'before-batch-open', tasks, seats: tasks.map(item => item.seat),
    nodeId: 'node-a' as T.SeatNodeId, seat: null, sessionId: null, operationId: 'batch' as T.SeatOperationId,
    callId: 'batch' as T.GateContext['callId'], observedAt: '2026-01-01T00:00:00Z' })
}
it('允许同仓分离文件和只读重叠，不以不同节点绕过同仓冲突', () => {
  expect(check([task('a', 'src/a.ts'), task('b', 'src/b.ts')]).outcome).toBe('allow')
  const read = { entries: [{ kind: 'file' as const, path: 'src/a.ts', access: 'read' as const }] }
  expect(check([task('a', '', read), task('b', '', read)]).outcome).toBe('allow')
  expect(check([task('a', 'src/a.ts'), task('b', 'src/a.ts')])).toMatchObject({ reason: 'scope-conflict', alternative: 'serial' })
  expect(check([task('a', 'src/a.ts'), { ...task('b', 'src/b.ts'), nodeId: 'node-b' as T.SeatNodeId }])).toMatchObject({ reason: 'scope-unknown' })
})
it('目录祖先、大小写不敏感和不可判定模式保守拒并批', () => {
  expect(check([task('a', '', { entries: [{ kind: 'directory', path: 'src', access: 'write' }] }), task('b', 'src/b.ts')])).toMatchObject({ reason: 'scope-conflict' })
  expect(check([task('a', 'SRC/A', { caseSensitive: false }), task('b', 'src/a', { caseSensitive: false })])).toMatchObject({ reason: 'scope-conflict' })
  expect(check([task('a', '', { patternSyntax: 'glob-v1', entries: [{ kind: 'pattern', path: 'src/**', access: 'write' }] }), task('b', 'docs/a')])).toMatchObject({ reason: 'scope-conflict' })
})
it('缺失、空、非法路径及版本不一致不伪造完整证据', () => {
  expect(check([])).toMatchObject({ reason: 'scope-unknown' })
  expect(check([task('a', '', { entries: [] })])).toMatchObject({ reason: 'scope-unknown' })
  for (const path of ['../a', '/a', 'a//b', 'C:/a']) expect(check([task('a', path)])).toMatchObject({ reason: 'scope-unknown' })
  expect(check([task('a', 'a'), task('b', 'b', { baseRevision: 'changed' })])).toMatchObject({ reason: 'scope-stale' })
  expect(check([task('a', 'a'), task('a', 'b')])).toMatchObject({ reason: 'scope-unknown' })
})
