import { describe, expect, it, vi } from 'vitest'
import type { RegisterSeatWorktreeRequest, SeatTaskEndedRequest, SeatWorktreeRegistration } from '@panedesk/dsh-seat'
import { WorktreePolicy } from '../src/worktree.ts'

const tree: SeatWorktreeRegistration = { repositoryId: 'repository-a', path: '/workspace/tree-a', seat: 'seat-a' as SeatWorktreeRegistration['seat'], taskId: 'task-a' as SeatWorktreeRegistration['taskId'], kind: 'client', branch: 'branch-a', registeredAt: '2026-01-01T00:00:00Z' }
const defaults = { clientTreesPerSlot: 1, staleOnSettle: 'notify' as const, lightByDefault: true, staleHours: 48 }
const operationId = 'operation-a' as RegisterSeatWorktreeRequest['operationId']

describe('non-destructive worktree defaults', () => {
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
    for (const evidence of [{ verified: true, merged: true, trackedClean: true, lastChangedAt: null }, { verified: true, merged: true, trackedClean: false, lastChangedAt: 0 }]) {
      const policy = new WorktreePolicy(defaults, async () => evidence, async () => false)
      expect(await policy.mature([tree], 99 * 3600000)).toEqual({ status: 'observed', trees: [], alternatives: [] })
    }
  })
})
