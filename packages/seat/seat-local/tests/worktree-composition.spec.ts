/** Real Git evidence drives non-destructive worktree observations through Loader. */
import { expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type * as T from '@panedesk/dsh-seat'
import { WorktreePolicy } from '../../seat-gates/src/worktree.ts'
import { commitsEffect, completesTurn, inputContains } from '../../seat/tests/completion.ts'
import { operation } from './fixtures.ts'
import { worktreeFixture } from './worktree-fixture.ts'

it('recognizes a merged linked worktree and retains client and settlement policies', async () => {
  const f = await worktreeFixture()
  try {
    const started = performance.now()
    const opened = await completesTurn(f.ctx, () => true, inputContains('Open seat-a'), () => f.seats.open({
      seat: f.definition.seat, origin: 'manual', operationId: operation('tree-opening'),
    }))
    expect(opened.status).toBe('opened')
    expect(await f.gates.registerWorktree({ registration: f.registration, operationId: operation('register-tree') }))
      .toMatchObject({ status: 'registered' })
    const beforeMerge = await f.host.inspect(f.registration)
    expect(beforeMerge).toMatchObject({ verified: true, trackedClean: true, merged: false })
    await f.merge()
    const merged = await f.host.inspect(f.registration)
    expect(merged).toMatchObject({ verified: true, trackedClean: true, merged: true })
    expect(typeof merged.lastChangedAt).toBe('number')
    const other = join(f.options.directory, 'other-tree')
    await f.git(f.repository, 'worktree', 'add', '-b', 'other', other, 'main')
    expect(await f.gates.registerWorktree({ registration: { ...f.registration, path: other, branch: 'other' },
      operationId: operation('second-client') })).toMatchObject({ status: 'rejected', error: { code: 'worktree-client-limit' } })
    const request: T.SeatTaskEndedRequest = { taskId: f.registration.taskId, kind: 'settle',
      sourceId: 'source-a' as T.SeatSourceId, operationId: operation('settle-tree') }
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 49 * 3_600_000)
    let observed: T.SeatWorktreeResult
    try {
      observed = await commitsEffect(f.ctx, effect => effect.kind === 'gate/hit'
        && effect.data.definition.id === 'worktree-mature', () => f.gates.onTaskEnded(request))
    } finally { clock.mockRestore() }
    expect(observed).toMatchObject({ status: 'observed', trees: [f.registration] })
    if (observed.status === 'rejected') throw new Error('Settlement was rejected')
    expect(observed.alternatives.some(text => text.includes('eligible for manual recycling'))).toBe(true)
    const hits = (await f.state.read()).effects.filter(effect => effect.kind === 'gate/hit')
    for (const name of ['worktree-client', 'worktree-settle', 'worktree-mature']) {
      expect(hits.filter(effect => effect.kind === 'gate/hit' && effect.data.definition.id === name)).toHaveLength(1)
    }
    expect(await readFile(join(f.path, 'retained.txt'), 'utf8')).toBe('Updated work.\n')
    process.stdout.write(`${JSON.stringify({ name: 'merged-worktree-observation', milliseconds: performance.now() - started })}\n`)
  } finally { await f.close() }
}, 20000)

it('does not mature an unmerged worktree even after the stale interval', async () => {
  const f = await worktreeFixture()
  try {
    const evidence = await f.host.inspect(f.registration)
    expect(evidence).toMatchObject({ verified: true, trackedClean: true, merged: false })
    expect(typeof evidence.lastChangedAt).toBe('number')
    const policy = new WorktreePolicy(f.definition.worktree, tree => f.host.inspect(tree), request => f.host.authorize(request))
    expect(await policy.mature([f.registration], Date.now() + 72 * 3_600_000)).toMatchObject({ status: 'observed', trees: [] })
  } finally { await f.close() }
})

it('refuses maturity with an explicit diagnostic when the configured target cannot be read', async () => {
  const f = await worktreeFixture()
  try {
    const diagnostic = vi.spyOn(f.ctx.logger, 'debug')
    await f.merge()
    await f.git(f.path, 'branch', '--unset-upstream')
    expect(await f.host.inspect(f.registration)).toEqual({ verified: true, trackedClean: true, merged: false, lastChangedAt: null })
    expect(diagnostic).toHaveBeenCalledWith(
      'Worktree maturity refused: Git upstream, ancestry or activity evidence is unavailable', 'Error')
    const policy = new WorktreePolicy(f.definition.worktree, tree => f.host.inspect(tree), request => f.host.authorize(request))
    expect(await policy.mature([f.registration], Date.now() + 72 * 3_600_000)).toMatchObject({ trees: [] })
    diagnostic.mockRestore()
  } finally { await f.close() }
})

it('keeps recent and dirty merged worktrees out of the default stale candidates', async () => {
  const f = await worktreeFixture()
  try {
    await f.merge()
    const evidence = await f.host.inspect(f.registration)
    expect(evidence.merged).toBe(true)
    expect(evidence.lastChangedAt).toBeGreaterThan(Date.now() - 60000)
    const policy = new WorktreePolicy(f.definition.worktree, tree => f.host.inspect(tree), request => f.host.authorize(request))
    expect(await policy.mature([f.registration], Date.now())).toMatchObject({ trees: [] })
    expect(await policy.mature([f.registration], Date.now() + 49 * 3_600_000))
      .toMatchObject({ trees: [f.registration] })
    await writeFile(join(f.path, 'retained.txt'), 'Uncommitted work.\n')
    expect(await policy.mature([f.registration], Date.now() + 49 * 3_600_000)).toMatchObject({ trees: [] })
  } finally { await f.close() }
})
