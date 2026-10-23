/** Real linked Git trees with a locally configured integration target. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type * as T from '@panedesk/dsh-seat'
import { admissionHost } from './admission-host.ts'
import * as Gates from '../../seat-gates/src/index.ts'

const execute = promisify(execFile)

export async function worktreeFixture() {
  const f = await admissionHost()
  try {
    f.ctx.loader.builtins.gates = Gates
    const ready = Promise.withResolvers<undefined>()
    f.ctx.inject(['seatGates'], () => { ready.resolve(undefined) })
    await f.load('worktree-gates.yml', [{ name: 'cordis:gates' }])
    await ready.promise
    const repository = join(f.options.directory, 'repository')
    const path = join(f.options.directory, 'linked-tree')
    await mkdir(repository)
    const git = async (cwd: string, ...args: string[]) => (await execute('git', ['-C', cwd, ...args], {
      encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' },
    })).stdout.trim()
    const commit = (cwd: string) => git(cwd, '-c', 'user.email=seat@example.test', '-c', 'user.name=seat',
      '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Retain work')
    await git(repository, 'init', '--initial-branch=main')
    await writeFile(join(repository, 'retained.txt'), 'Retained work.\n')
    await git(repository, 'add', '--', 'retained.txt')
    await commit(repository)
    await git(repository, 'worktree', 'add', '-b', 'topic', path, 'main')
    await git(path, 'branch', '--set-upstream-to=main', 'topic')
    await writeFile(join(path, 'retained.txt'), 'Updated work.\n')
    await git(path, 'add', '--', 'retained.txt')
    await commit(path)
    const registration: T.SeatWorktreeRegistration = { repositoryId: join(repository, '.git'), path,
      seat: f.definition.seat, taskId: 'task-a' as T.SeatTaskId, kind: 'client', branch: 'topic', registeredAt: new Date().toISOString() }
    return { ...f, git, commit, repository, path, registration, gates: f.ctx.get('seatGates')!,
      host: f.ctx.get('seatWorktreeHost')!,
      merge: () => git(repository, '-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', 'topic') }
  } catch (error) { await f.close(); throw error }
}
