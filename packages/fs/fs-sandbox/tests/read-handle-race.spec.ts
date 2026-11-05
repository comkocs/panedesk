/** Concurrent path replacement must not disclose owner documents through host reads. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Context } from '@panedesk/cordis'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SandboxPolicyService from '@panedesk/dsh-sandbox-policy'
import SandboxedFileSystem from '@panedesk/dsh-fs-sandbox'
import { expect, it, vi } from 'vitest'

it.each(['file', 'directory'] as const)('never discloses owner content during %s replacement', async (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'read-handle-race-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const owner = join(home, 'private')
  mkdirSync(workspace)
  mkdirSync(owner, { recursive: true })
  writeFileSync(join(owner, 'document'), 'synthetic owner content')
  const entry = join(workspace, 'entry')
  if (kind === 'directory') mkdirSync(entry)
  const requested = kind === 'file' ? entry : join(entry, 'document')
  writeFileSync(requested, 'ordinary project content')
  vi.stubEnv('PANEDESK_HOME', home)
  const ctx = new Context()
  const stop = new Int32Array(new SharedArrayBuffer(4))
  let writer: Worker | undefined
  try {
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
    await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
    const target = await ctx.fs.resolve(requested)
    writer = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { renameSync, symlinkSync, unlinkSync } = require('node:fs');
      const { entry, destination, kind, stop } = workerData;
      const parked = entry + '.parked';
      parentPort.postMessage('ready');
      while (!Atomics.load(stop, 0)) {
        renameSync(entry, parked);
        symlinkSync(destination, entry, kind === 'directory' ? 'junction' : 'file');
        unlinkSync(entry);
        renameSync(parked, entry);
      }
    `, { eval: true, workerData: {
      entry, destination: kind === 'file' ? join(owner, 'document') : owner, kind, stop,
    } })
    const exited = new Promise<void>((resolve, reject) => {
      writer!.once('error', reject)
      writer!.once('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`writer exit ${code}`))
      })
    })
    let hits = 0
    let ordinary = 0
    let denied = 0
    try {
      for (let round = 0; round < 1024; round++) {
        await Promise.all(Array.from({ length: 4 }, async (_, form) => {
          try {
            let content: string
            if (form === 0) content = await ctx.fs.readText(target)
            else if (form === 1) content = Buffer.from(await ctx.fs.readBytes(target, undefined, 1024)).toString()
            else if (form === 2) content = Buffer.from(await ctx.fs.readByteRange(target, { offset: 0, length: 1024 })).toString()
            else {
              content = ''
              for await (const chunk of await ctx.fs.streamText(target)) content += chunk
            }
            if (content.includes('synthetic owner content')) hits++
            if (content === 'ordinary project content') ordinary++
          } catch (_replacementOrDenial) {
            // A removed name or a refused replacement is not a successful disclosure.
            denied++
          }
        }))
      }
    } finally {
      Atomics.store(stop, 0, 1)
      await exited
      writer = undefined
    }
    console.log(JSON.stringify({ kind, attempts: 4096, hits, ordinary, denied }))
    expect(hits).toBe(0)
    expect(await ctx.fs.readText(await ctx.fs.resolve(requested))).toBe('ordinary project content')
    const alias = join(workspace, 'alias')
    symlinkSync(requested, alias)
    expect(await ctx.fs.readText(await ctx.fs.resolve(alias))).toBe('ordinary project content')
    const entries = await ctx.fs.listDir(await ctx.fs.resolve(owner), undefined, {
      mode: 'danger-full-access', workspaceRoot: workspace,
    })
    expect(entries.map(entry => entry.name)).toContain('document')
  } finally {
    Atomics.store(stop, 0, 1)
    if (writer) await writer.terminate()
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
})
