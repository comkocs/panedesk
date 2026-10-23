import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GitTrigger } from '../src/git-trigger.ts'
import type * as T from '@panedesk/dsh-seat'

const execute = promisify(execFile)
it('A08 observes loose and packed refs, deletion and recreation without triggering its baseline', async () => {
  const root = await mkdtemp(join(process.cwd(), 'packages/seat/seat-engine/tests/.git-'))
  const events: T.SeatTriggerEvidence[] = []
  const git = (...args: string[]) => execute('git', args, { cwd: root })
  let sequence = 0
  const watcher = new GitTrigger({ repository: root, repositoryId: 'repo-a' as never, ref: 'refs/heads/main', checkpoint: join(root, 'observer.json'), fallbackMs: 1000,
    onError: (error) => { throw error }, accept: async (evidence) => { events.push(evidence); return { status: 'accepted', triggerId: 'trigger-a' as T.TriggerId, queueItemId: 'queue-a' as T.QueueItemId, sequence: ++sequence } } })
  try {
    await git('init', '--bare')
    const tree = (await git('hash-object', '-w', '-t', 'tree', '/dev/null')).stdout.trim()
    const commit = (await execute('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit-tree', tree, '-m', 'Test'], { cwd: root })).stdout.trim()
    await watcher.scan(); expect(events).toEqual([])
    await git('update-ref', 'refs/heads/main', commit); await watcher.scan()
    await git('pack-refs', '--all'); await watcher.scan()
    expect(events).toHaveLength(1)
    await git('update-ref', '-d', 'refs/heads/main'); await watcher.scan()
    await git('update-ref', 'refs/heads/main', commit); await watcher.scan()
    expect(events.map(event => event.kind === 'git' ? event.observationSequence : -1)).toEqual([1, 2, 3])
    expect(events[1]).toMatchObject({ oldObjectId: commit, newObjectId: null })
    expect(JSON.parse(await readFile(join(root, 'observer.json'), 'utf8'))).toMatchObject({ sequence: 3 })
  } finally { await watcher.stop(); await rm(root, { recursive: true, force: true }) }
})
