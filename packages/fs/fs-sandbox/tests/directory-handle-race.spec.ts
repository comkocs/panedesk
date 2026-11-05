/** Directory replacements cannot redirect host mutations or metadata reads. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Context } from '@panedesk/cordis'
import { LocalFileSystem } from '@panedesk/dsh-fs-local'
import { FsTargetKey } from '@panedesk/dsh-fs'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import { SandboxedFileSystem } from '@panedesk/dsh-fs-sandbox'
import { expect, it, vi } from 'vitest'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'directory-race-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  const entry = join(workspace, 'entry')
  mkdirSync(entry, { recursive: true })
  mkdirSync(outside)
  const ctx = new Context()
  try {
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
    await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
    return { ctx, root, workspace, outside, entry }
  } catch (error) {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

it('never creates outside the authorized workspace during 1024 directory replacements', async () => {
  const { ctx, root, workspace, outside, entry } = await fixture()
  const stop = new Int32Array(new SharedArrayBuffer(4))
  let writer: Worker | undefined
  try {
    writer = new Worker(`
      const { workerData } = require('node:worker_threads');
      const { renameSync, symlinkSync, unlinkSync } = require('node:fs');
      const { entry, outside, stop } = workerData;
      let displaced = 0;
      while (!Atomics.load(stop, 0)) {
        const parked = entry + '.parked-' + displaced++;
        try { renameSync(entry, parked); } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        try {
          try { symlinkSync(outside, entry, 'junction'); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        } finally {
          try { unlinkSync(entry); } catch (error) {
            if (error.code === 'EISDIR') renameSync(entry, entry + '.displaced-' + displaced++);
            else if (error.code !== 'ENOENT') throw error;
          }
          try { renameSync(parked, entry); }
          catch (error) {
            if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
            renameSync(parked, entry + '.displaced-' + displaced++);
          }
        }
      }
    `, { eval: true, workerData: { entry, outside, stop } })
    const exited = new Promise<void>((resolve, reject) => {
      writer!.once('error', reject)
      writer!.once('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`writer exit ${code}`))
      })
    })
    void exited.catch(() => undefined)
    let accepted = 0
    let denied = 0
    try {
      for (let round = 0; round < 1024; round++) {
        const path = join(entry, `new-${round}`)
        try {
          await ctx.fs.writeText({ displayPath: path, targetKey: FsTargetKey(path) }, 'host write', { kind: 'createIfAbsent' }, undefined, {
            mode: 'workspace-write', workspaceRoot: workspace, protectedPaths: [outside],
          })
          accepted++
        } catch (_replacementOrDenial) {
          // A refused or removed entry does not count as a successful write.
          denied++
        }
      }
    } finally {
      Atomics.store(stop, 0, 1)
      await exited
      writer = undefined
    }
    const escaped = readdirSync(outside).filter(name => name.startsWith('new-')).length
    console.log(JSON.stringify({ rounds: 1024, accepted, denied, escaped }))
    expect(escaped).toBe(0)
  } finally {
    Atomics.store(stop, 0, 1)
    if (writer) await writer.terminate()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['writeText', 'stat', 'listDir'] as const)('does not follow an ancestor replaced after %s admission', async (operation) => {
  const { ctx, root, workspace, outside, entry } = await fixture()
  writeFileSync(join(outside, 'secret'), 'outside metadata')
  const path = operation === 'writeText' ? join(entry, 'created') : entry
  const target = await ctx.fs.resolve(path)
  let swapped = false
  const swap = () => {
    if (swapped) return
    swapped = true
    renameSync(entry, `${entry}.parked`)
    symlinkSync(outside, entry, 'junction')
  }
  const originalWrite = LocalFileSystem.prototype.writeText.bind(ctx.fs)
  const originalStat = LocalFileSystem.prototype.stat.bind(ctx.fs)
  const originalList = LocalFileSystem.prototype.listDir.bind(ctx.fs)
  if (operation === 'writeText') vi.spyOn(LocalFileSystem.prototype, 'writeText').mockImplementation(function (this: LocalFileSystem, ...args) {
    swap()
    return originalWrite.apply(this, args)
  })
  else if (operation === 'stat') vi.spyOn(LocalFileSystem.prototype, 'stat').mockImplementation(function (this: LocalFileSystem, ...args) {
    swap()
    return originalStat.apply(this, args)
  })
  else vi.spyOn(LocalFileSystem.prototype, 'listDir').mockImplementation(function (this: LocalFileSystem, ...args) {
    swap()
    return originalList.apply(this, args)
  })
  try {
    let accepted = false
    try {
      if (operation === 'writeText') await ctx.fs.writeText(target, 'host write', { kind: 'createIfAbsent' }, undefined, {
        mode: 'workspace-write', workspaceRoot: workspace, protectedPaths: [outside],
      })
      else if (operation === 'stat') await ctx.fs.stat(target)
      else await ctx.fs.listDir(target)
      accepted = true
    } catch (_replacedDirectory) {
      // No path-based fallback is allowed after the authorized directory is replaced.
    }
    expect(swapped).toBe(true)
    expect(existsSync(join(outside, 'created'))).toBe(false)
    expect(accepted).toBe(false)
  } finally {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
