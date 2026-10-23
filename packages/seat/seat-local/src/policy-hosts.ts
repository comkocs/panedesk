/** Policy hosts reuse durable storage, Workspace identity and Session message delivery. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@panedesk/cordis'
import { defineDomain, type DomainFacility } from '@panedesk/dsh-storage-domain'
import type * as T from '@panedesk/dsh-seat'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import { z } from 'zod'
import { digest } from './store.ts'

const execute = promisify(execFile)
const treeSchema = z.object({ repositoryId: z.string(), path: z.string(), seat: z.string(), taskId: z.string(),
  kind: z.enum(['light', 'client']), branch: z.string(), registeredAt: z.string() })
const schema = z.object({ revision: z.number().int().nonnegative(), trees: z.array(treeSchema),
  operations: z.record(z.string(), z.string()),
  forceAudit: z.array(z.object({ operationId: z.string(), reference: z.string(), reason: z.string() })) })
const spec = defineDomain({ name: 'seat_worktrees', version: 1, layout: 'single', tables: {},
  global: { schema, initial: schema.parse({ revision: 0, trees: [], operations: {}, forceAudit: [] }) } })

async function git(cwd: string, args: string[], trim = true): Promise<string> {
  const result = await execute('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8' })
  return trim ? result.stdout.trim() : result.stdout
}

async function maturity(path: string): Promise<{ merged: boolean; lastChangedAt: number }> {
  // The branch upstream is the repository's explicit merge target; never guess main or HEAD.
  const target = await git(path, ['rev-parse', '--verify', '@{upstream}^{commit}'])
  const head = await git(path, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const base = await git(path, ['merge-base', head, target])
  const committedAt = Number(await git(path, ['log', '-1', '--format=%ct', head])) * 1000
  const files = (await git(path, ['ls-files', '-z'], false)).split('\0').filter(Boolean)
  const metadata = await Promise.all(['HEAD', 'index', 'logs/HEAD'].map(async name =>
    git(path, ['rev-parse', '--path-format=absolute', '--git-path', name])))
  let lastChangedAt = committedAt
  for (const file of [...metadata, ...files.map(file => join(path, file))]) {
    const info = await stat(file)
    lastChangedAt = Math.max(lastChangedAt, info.mtimeMs, info.ctimeMs)
  }
  if (!Number.isFinite(lastChangedAt) || committedAt <= 0) throw new Error('Worktree activity time is unavailable')
  const unchanged = head === await git(path, ['rev-parse', '--verify', 'HEAD^{commit}'])
    && target === await git(path, ['rev-parse', '--verify', '@{upstream}^{commit}'])
    && (await git(path, ['status', '--porcelain', '--untracked-files=no'])).length === 0
  return { merged: unchanged && base === head, lastChangedAt }
}

/** Install hosts under the catalog owner's lifecycle; teardown drains committed writes.
 * @param ctx - local plugin context.
 * @param facility - existing atomic storage provider.
 * @returns asynchronous teardown for the worktree domain.
 */
export async function installPolicyHosts(ctx: Context, facility: DomainFacility): Promise<() => Promise<void>> {
  const domain = await facility.open(spec)
  let tail = Promise.resolve()
  let stopped = false
  const host: T.SeatWorktreeHost = {
    read: () => {
      const state = domain.global.get()
      return Promise.resolve({ revision: state.revision, trees: state.trees.map(tree => ({ ...tree,
        seat: tree.seat as T.SeatName, taskId: tree.taskId as T.SeatTaskId })) })
    },
    commit: (request, expectedRevision) => {
      if (stopped) return Promise.reject(new Error('Worktree host is closing'))
      const run = tail.then(async () => {
        const current = structuredClone(domain.global.get())
        const hash = digest(request)
        if (current.operations[request.operationId] !== undefined) {
          if (current.operations[request.operationId] !== hash) throw new Error('Worktree operation identity changed')
          return 'committed' as const
        }
        if (current.revision !== expectedRevision) return 'conflict' as const
        if (request.force && !await host.authorize(request)) throw new Error('Worktree force authorization is unavailable')
        const workspace = ctx.get('workspaceRegistry')
        if (!workspace) throw new Error('Workspace registry is unavailable')
        await workspace.create(request.registration.path)
        const index = current.trees.findIndex(tree => tree.path === request.registration.path)
        if (index < 0) current.trees.push(request.registration)
        else current.trees[index] = request.registration
        current.revision++
        current.operations[request.operationId] = hash
        if (request.force) current.forceAudit.push({ operationId: request.operationId,
          reference: request.force.authorizationRef, reason: request.force.reason })
        await domain.global.set(schema.parse(current))
        return 'committed' as const
      })
      tail = run.then(() => {}, () => {})
      return run
    },
    inspect: async (tree) => {
      try {
        const path = await realpath(tree.path)
        const common = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
        const repository = await realpath(tree.repositoryId)
        const branch = await git(path, ['symbolic-ref', '--short', 'HEAD'])
        const listed = await git(path, ['worktree', 'list', '--porcelain'])
        const verified = await realpath(common) === repository && branch === tree.branch
          && listed.split('\n').includes(`worktree ${path}`)
        const trackedClean = (await git(path, ['status', '--porcelain', '--untracked-files=no'])).length === 0
        let evidence: { merged: boolean; lastChangedAt: number | null }
        try { evidence = await maturity(path) }
        catch (error) {
          // Missing upstream, history or activity metadata cannot establish maturity.
          ctx.logger.debug('Worktree maturity refused: Git upstream, ancestry or activity evidence is unavailable',
            error instanceof Error ? error.name : 'Error')
          evidence = { merged: false, lastChangedAt: null }
        }
        return { verified, trackedClean, ...evidence }
      } catch (error) {
        ctx.logger.debug('Worktree evidence is unavailable', error instanceof Error ? error.name : 'Error')
        return { verified: false, trackedClean: false, merged: false, lastChangedAt: null }
      }
    },
    authorize: request => Promise.resolve(request.force === undefined),
  }
  ctx.provide('seatWorktreeHost', host)
  ctx.provide('seatReminderHost', {
    send: async (request) => {
      const delivery = ctx.get('messageDelivery')
      if (!delivery) return 'rejected'
      const result = await delivery.send({ target: { sessionId: request.sessionId }, content: request.content,
        operationId: digest(['seat-reminder', request.id]) as string as OperationId, messageClass: 'handoff', priority: request.kind })
      return result.deliveryOutcome === 'accepted' ? 'accepted' : 'rejected'
    },
  })
  return async () => { stopped = true; await tail; await domain.close() }
}
