/** Trusted admission injection preserves default rejection and existing local execution. */
import { expect, it, vi } from 'vitest'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'

it('injects conflict, unknown and disjoint decisions before creating any batch member and drains disposal', async () => {
  const f = await admissionHost()
  try {
    const contexts = f.ctx.get('seatOpeningContexts')!
    const taskId = 'task-a' as T.SeatTaskId
    const task: T.SeatTaskScopeContext = { taskId, seat: f.definition.seat, nodeId: f.options.nodeId,
      scopeEvidenceRef: 'frozen-scope' as T.SeatTaskScopeContext['scopeEvidenceRef'],
      scopeEvidence: { status: 'known', taskId, revision: '1', repositoryId: 'repo' as T.TaskRepositoryId,
        baseRevision: 'base', entries: [{ kind: 'file', path: 'a.ts', access: 'write' }], patternSyntax: 'literal', caseSensitive: true } }
    const request: T.OpenSeatBatchWithScopeRequest = { seats: [f.definition.seat], tasks: [task], origin: 'manual',
      operationId: operation('injected-batch') }
    expect(await contexts.openBatch(request, f.authority)).toMatchObject({ error: { message: 'scope-unknown', alternative: 'serial' } })
    let reason: 'scope-conflict' | 'scope-unknown' | null = 'scope-conflict'
    const evaluateTaskScopes = vi.fn(async (): Promise<T.TaskScopeGateDecision> => reason
      ? { outcome: 'deny', reason, alternative: 'serial', conflicts: [] }
      : { outcome: 'allow', revisions: [{ taskId, revision: '1' }] })
    const release = contexts.registerScopeAdmission!({ evaluateTaskScopes,
      batch: (_request, _authority, execute) => execute(), open: (_request, _authority, execute) => execute() })
    const before = (await f.state.read()).effects.filter(effect => effect.kind === 'open/created').length
    expect(await contexts.openBatch(request, f.authority)).toMatchObject({ error: { message: 'scope-conflict', alternative: 'serial' } })
    reason = 'scope-unknown'
    expect(await contexts.openBatch(request, f.authority)).toMatchObject({ error: { message: 'scope-unknown', alternative: 'serial' } })
    expect((await f.state.read()).effects.filter(effect => effect.kind === 'open/created')).toHaveLength(before)
    reason = null
    expect(await contexts.openBatch(request, f.authority)).toMatchObject({ status: 'processed' })
    expect(evaluateTaskScopes).toHaveBeenCalledTimes(3)
    await release()
    expect(await contexts.openBatch({ ...request, operationId: operation('after-disposal') }, f.authority))
      .toMatchObject({ error: { message: 'scope-unknown', alternative: 'serial' } })
    const started = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<T.OpenSeatBatchResult>()
    const drain = contexts.registerScopeAdmission!({ evaluateTaskScopes,
      batch: () => { started.resolve(undefined); return finish.promise }, open: (_request, _authority, execute) => execute() })
    const pending = contexts.openBatch({ ...request, operationId: operation('draining') }, f.authority)
    await started.promise
    let disposed = false
    const closing = drain().then(() => { disposed = true })
    expect(await contexts.openBatch(request, f.authority)).toMatchObject({ status: 'rejected' })
    expect(disposed).toBe(false)
    finish.resolve({ status: 'processed', results: [] })
    await pending
    await closing
    expect(disposed).toBe(true)
  } finally { await f.close() }
})
