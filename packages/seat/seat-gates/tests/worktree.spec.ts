import { describe, expect, it, vi } from 'vitest'
import type { RegisterSeatWorktreeRequest, SeatTaskEndedRequest, SeatWorktreeRegistration } from '@panedesk/dsh-seat'
import { WorktreePolicy } from '../src/worktree.ts'
import { inspectWorktree } from '../src/worktree-git.ts'
import { registerWorktree, taskEnded } from '../src/worktree-service.ts'
import { policyContext } from './harness.ts'

const tree: SeatWorktreeRegistration = { repositoryId: 'repository-a', path: '/workspace/tree-a', seat: 'seat-a' as SeatWorktreeRegistration['seat'], taskId: 'task-a' as SeatWorktreeRegistration['taskId'], kind: 'client', branch: 'branch-a', registeredAt: '2026-01-01T00:00:00Z' }
const defaults = { clientTreesPerSlot: 1, staleOnSettle: 'notify' as const, lightByDefault: true, staleHours: 48 }
const operationId = 'operation-a' as RegisterSeatWorktreeRequest['operationId']

describe('non-destructive worktree defaults', () => {
  it('acknowledges registration only after durable CAS and preserves force audit for restart', async () => {
    const { ctx } = policyContext()
    const records: SeatWorktreeRegistration[] = []
    const commits: RegisterSeatWorktreeRequest[] = []
    let revision = 0
    let conflict = true
    const host: import('@panedesk/dsh-seat').SeatWorktreeHost = {
      async read() { return { revision, trees: [...records] } },
      async inspect() { return { verified: true, merged: true, trackedClean: true, lastChangedAt: 0 } },
      async authorize(request) { return request.force?.authorizationRef === 'authorization-a' },
      async commit(request, expected) {
        if (conflict) { conflict = false; revision++; return 'conflict' }
        if (expected !== revision) return 'conflict'
        commits.push(request)
        records.push(request.registration)
        revision++
        return 'committed'
      },
    }
    ctx.provide('seatWorktreeHost', host)
    try {
      expect(await registerWorktree(ctx, { registration: tree, operationId })).toMatchObject({ status: 'registered' })
      expect(commits).toHaveLength(1)
      const second = { registration: { ...tree, path: '/workspace/tree-b' }, operationId }
      expect(await registerWorktree(ctx, second)).toMatchObject({ status: 'rejected', error: { code: 'worktree-client-limit' } })
      const force = { reason: 'Explicit review.', authorizationRef: 'authorization-a' as import('@panedesk/dsh-seat').AuthorizationRef }
      expect(await registerWorktree(ctx, { ...second, force })).toMatchObject({ status: 'registered' })
      expect(commits[1]?.force).toEqual(force)
      const settled = await taskEnded(ctx, { taskId: tree.taskId, kind: 'settle',
        sourceId: 'source-a' as SeatTaskEndedRequest['sourceId'], operationId })
      expect(settled).toMatchObject({ status: 'observed', trees: records })
      expect(commits).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
  })
  it('checks explicit Git worktree identity and refuses incomplete or unknown maturity evidence', async () => {
    const read = vi.fn(async (_cwd: string, args: readonly string[]) => ({ code: 0, complete: true,
      stdout: args[0] === 'worktree' ? `worktree ${tree.path}\0HEAD hash-a\0branch refs/heads/${tree.branch}\0\0` : '' }))
    expect(await inspectWorktree(read, '/workspace/repository', 'main', tree, null)).toEqual({
      verified: true, merged: true, trackedClean: true, lastChangedAt: null,
    })
    expect(read.mock.calls.map(call => call[1][0])).toEqual(['worktree', 'status', 'merge-base'])
    read.mockResolvedValue({ code: 0, complete: false, stdout: '' })
    expect((await inspectWorktree(read, '/workspace/repository', 'main', tree, 0)).verified).toBe(false)
  })
  it('refuses a second client tree and gives the existing tree as its alternative', async () => {
    const inspect = async () => ({ verified: true, merged: true, trackedClean: true, lastChangedAt: 0 })
    const policy = new WorktreePolicy(defaults, inspect, async () => false)
    const result = await policy.register({ registration: { ...tree, path: '/workspace/tree-b' }, operationId }, [tree])
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'worktree-client-limit', alternative: 'Use the registered tree "/workspace/tree-a" and switch its branch instead.', effectState: 'none' } })
    expect(await policy.register({ registration: { ...tree, kind: 'light', path: '/workspace/tree-b' }, operationId }, [tree])).toMatchObject({ status: 'registered' })
  })
  it('observes task settlement and mature trees without deleting or committing', async () => {
    const inspect = vi.fn(async () => ({ verified: true, merged: true, trackedClean: true, lastChangedAt: 0 }))
    const policy = new WorktreePolicy(defaults, inspect, async () => false)
    const settled = policy.onTaskEnded({ taskId: tree.taskId, kind: 'settle', sourceId: 'source-a' as SeatTaskEndedRequest['sourceId'], operationId }, [tree])
    expect(settled).toMatchObject({ status: 'observed', trees: [tree] })
    if (settled.status !== 'rejected') expect(settled.alternatives[0]).toContain('status --short')
    const mature = await policy.mature([tree], 48 * 3600000)
    expect(mature).toMatchObject({ status: 'observed', trees: [tree] })
    if (mature.status !== 'rejected') expect(mature.alternatives[0]).toContain('manual recycling')
    expect(inspect).toHaveBeenCalledTimes(1)
  })
  it('does not infer maturity from missing activity evidence or dirty tracked files', async () => {
    for (const evidence of [
      { verified: true, merged: true, trackedClean: true, lastChangedAt: null },
      { verified: true, merged: true, trackedClean: false, lastChangedAt: 0 },
    ]) {
      const policy = new WorktreePolicy(defaults, async () => evidence, async () => false)
      expect(await policy.mature([tree], 99 * 3600000)).toEqual({ status: 'observed', trees: [], alternatives: [] })
    }
  })
})
