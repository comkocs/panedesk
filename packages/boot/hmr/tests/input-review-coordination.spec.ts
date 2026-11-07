/** HMR reviews share reader scheduling, not admission or owner decisions. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Timer from '@panedesk/cordis-plugin-timer'
import { ProtectedInputIntegrity, type ProfileContext, type ProtectedInputChange } from '@panedesk/dsh-app-boot'
import { InputReviewThread } from '@panedesk/dsh-app-boot/src/input-review-thread.ts'
import { SessionId } from '@panedesk/dsh-session'
import { FSWatcher } from 'chokidar'
import { expect, it, vi } from 'vitest'
import ApprovalService from '../../../interaction/user-approval/src/index.ts'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '../../../test-support/agent-loop-testkit/src/index.ts'
import Hmr from '../src/index.ts'

const watchers = vi.hoisted(() => [] as FSWatcher[])
vi.mock('chokidar', async (original) => {
  const native = await original<typeof import('chokidar')>()
  return { ...native, watch: () => {
    const watcher = new native.FSWatcher()
    watchers.push(watcher)
    queueMicrotask(() => watcher.emit('ready'))
    return watcher
  } }
})

it('serializes HMR with first write admission and keeps subsequent scans and owner decisions independent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hmr-reader-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  mkdirSync(workspace)
  const path = join(workspace, 'entry.js')
  writeFileSync(path, 'approved')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(workspace).href + '/'
  const releaseScan = Promise.withResolvers<undefined>()
  const releaseOwner = Promise.withResolvers<'rejected'>()
  let reader: ProtectedInputIntegrity | undefined
  try {
    await ctx.plugin(Loader)
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(ApprovalService)
    const harness = await mountAgentLoopTestHarness(ctx)
    await harness.create(SessionId('reader-owner'), {}, { cwd: workspace })
    reader = await ProtectedInputIntegrity.openOwnerRecordsAsync(workspace, home)
    reader.observe(path)
    const profile: ProfileContext = {
      name: 'test', dir: workspace, home, cwd: workspace, patchPath: path,
      installAnchor: path, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
      inputIntegrity: reader,
    }
    ctx.provide('profileContext', profile)
    const refreshed = vi.fn(async () => {})
    await ctx.hmr.watchConfig(path, refreshed)
    const watcher = watchers.at(-1)
    if (watcher === undefined) throw new Error('Configuration watcher was not registered')
    const scanEntered = Promise.withResolvers<undefined>()
    const admissionQueued = Promise.withResolvers<undefined>()
    const scans = vi.spyOn(InputReviewThread.prototype, 'run').mockImplementationOnce(async function (this: InputReviewThread, ...args) {
      scanEntered.resolve(undefined)
      await releaseScan.promise
      return this.run(...args)
    })
    const verified = vi.spyOn(reader, 'verify')
    watcher.emit('change', path)
    await scanEntered.promise
    const review = reader.review.bind(reader)
    vi.spyOn(reader, 'review').mockImplementation((owner) => {
      const pending = review(owner)
      admissionQueued.resolve(undefined)
      return pending
    })
    const admission = reader.ensureWrite()
    const outcomes = Promise.allSettled([admission, ctx.hmr.runExclusive(async () => {})])
    await admissionQueued.promise
    releaseScan.resolve(undefined)
    expect(await outcomes).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
    ])
    // The one-shot gate re-enters the original method; two separate requests still reach the worker.
    expect(scans).toHaveBeenCalledTimes(3)
    expect(scans.mock.calls[0]).toEqual(scans.mock.calls[1])
    expect(scans.mock.calls[1]?.[0]).not.toBe(scans.mock.calls[2]?.[0])
    expect(verified).toHaveBeenCalledTimes(2)
    expect(verified.mock.calls[0]?.[0]).not.toBe(verified.mock.calls[1]?.[0])
    expect(refreshed).toHaveBeenCalledOnce()
    expect(reader.readTrusted(path)?.toString()).toBe('approved')
    scans.mockRestore()
    vi.restoreAllMocks()
    await reader.disposeReview()

    // First admission cannot approve edits. Use a recorded reader to observe two refusal decisions.
    const recorded = new ProtectedInputIntegrity(workspace, home)
    profile.inputIntegrity = recorded
    reader = recorded
    writeFileSync(path, 'changed')
    const ownerEntered = Promise.withResolvers<undefined>()
    const decisions = vi.spyOn(ctx.approval, 'requestProtectedInput').mockImplementation(async () => {
      ownerEntered.resolve(undefined)
      return releaseOwner.promise
    })
    const verify = vi.spyOn(recorded, 'verify')
    watcher.emit('change', path)
    await ownerEntered.promise
    const admissionOwner = { blocked: vi.fn(), confirm: vi.fn(async (_change: ProtectedInputChange) => false) }
    const independent = recorded.review(admissionOwner)
    const finished = Promise.allSettled([independent, ctx.hmr.runExclusive(async () => {})])
    expect(verify).toHaveBeenCalledOnce()
    releaseOwner.resolve('rejected')
    expect(await finished).toEqual([
      { status: 'fulfilled', value: false },
      { status: 'fulfilled', value: undefined },
    ])
    expect(verify).toHaveBeenCalledTimes(2)
    expect(decisions).toHaveBeenCalledOnce()
    expect(admissionOwner.blocked).toHaveBeenCalledOnce()
    expect(admissionOwner.confirm).toHaveBeenCalledOnce()
    const candidate = decisions.mock.calls[0]?.[1]
    if (candidate === undefined) throw new Error('HMR did not request an owner decision')
    expect(admissionOwner.confirm.mock.calls[0]?.[0]).toEqual({
      path, previous: candidate.previous, current: candidate.current,
    })
    expect(refreshed).toHaveBeenCalledOnce()
    expect(recorded.readTrusted(path)?.toString()).toBe('approved')
  } finally {
    releaseScan.resolve(undefined)
    releaseOwner.resolve('rejected')
    await reader?.disposeReview()
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  }
})
