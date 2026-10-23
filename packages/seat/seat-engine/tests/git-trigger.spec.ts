import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GitTrigger } from '../src/git-trigger.ts'
import type * as T from '@panedesk/dsh-seat'
import { harness, trigger } from './fixtures.ts'

const execute = promisify(execFile)
it('A08 observes loose and packed refs, deletion and recreation without triggering its baseline', async () => {
  const root = await mkdtemp(join(process.cwd(), 'packages/seat/seat-engine/tests/.git-'))
  const events: T.SeatTriggerEvidence[] = []
  const git = (...args: string[]) => execute('git', args, { cwd: root })
  const h = await harness()
  let engine = h.engine
  const options = { repository: root, repositoryId: 'repo-a' as Extract<T.SeatTriggerEvidence, { kind: 'git' }>['repositoryId'], ref: 'refs/heads/main',
    checkpoint: join(root, 'observer.json'), fallbackMs: 1000,
    onError: (error: unknown) => { throw error },
    accept: async (evidence: Extract<T.SeatTriggerEvidence, { kind: 'git' }>) => {
      events.push(evidence)
      return engine.accept({ ...trigger('git', `git-${evidence.observationSequence}`), evidence })
    } }
  let watcher = new GitTrigger({ ...options, journal: engine.journal })
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
    expect(engine.journal.projection.git.get(JSON.stringify(['repo-a', 'refs/heads/main']))).toMatchObject({ sequence: 3 })
    const accepted = engine.journal.projection.decisions.filter(item => item.effects.some(effect => effect.kind === 'trigger/accepted'
      || effect.kind === 'trigger/coalesced'))
    expect(accepted).toHaveLength(3)
    expect(accepted.every(item => item.effects.some(effect => effect.kind === 'git/checkpoint'))).toBe(true)
    await writeFile(options.checkpoint, JSON.stringify({ schemaVersion: 1, repositoryId: 'repo-a',
      ref: options.ref, objectId: null, sequence: 0 }))
    await watcher.stop(); await engine.shutdown(); engine = await h.start()
    watcher = new GitTrigger({ ...options, journal: engine.journal })
    await watcher.scan()
    expect(events).toHaveLength(3)
    await git('update-ref', '-d', options.ref); await watcher.scan()
    expect(events.at(-1)).toMatchObject({ observationSequence: 4, oldObjectId: commit, newObjectId: null })
  } finally { await watcher.stop(); await h.close(); await rm(root, { recursive: true, force: true }) }
})
it.each([7, -1])('migrates a valid legacy checkpoint once and rejects negative sequence %s', async (sequence) => {
  const h = await harness(), root = await mkdtemp(join(process.cwd(), 'packages/seat/seat-engine/tests/.git-'))
  const checkpoint = join(root, 'observer.json')
  const bytes = JSON.stringify({ schemaVersion: 1, repositoryId: 'repo-a', ref: 'refs/heads/main', objectId: null, sequence })
  const watcher = new GitTrigger({ repository: root, repositoryId: 'repo-a' as never, ref: 'refs/heads/main',
    checkpoint, journal: h.engine.journal, fallbackMs: 1000, onError: (error) => { throw error },
    accept: () => { throw new Error('An unchanged migrated baseline must not trigger') } })
  try {
    await execute('git', ['init', '--bare'], { cwd: root }); await writeFile(checkpoint, bytes)
    if (sequence < 0) {
      await expect(watcher.scan()).rejects.toThrow('Invalid git observation checkpoint')
      expect(h.engine.journal.projection.git.size).toBe(0)
    } else {
      await watcher.scan(); await watcher.scan()
      expect(h.engine.journal.projection.git.get(JSON.stringify(['repo-a', 'refs/heads/main']))).toMatchObject({ sequence })
      expect(h.engine.journal.projection.decisions.flatMap(item => item.effects)
        .filter(effect => effect.kind === 'git/checkpoint')).toHaveLength(1)
      expect(await readFile(checkpoint, 'utf8')).toBe(bytes)
    }
  } finally { await watcher.stop(); await h.close(); await rm(root, { recursive: true, force: true }) }
})
