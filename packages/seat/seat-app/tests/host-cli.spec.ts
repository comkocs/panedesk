import { Context } from '@panedesk/cordis'
import { describe, expect, it, vi } from 'vitest'
import { executeSeatCommand } from '../src/cli.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import * as App from '../src/index.ts'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as Admin from '@panedesk/dsh-host-admin'

describe('host CLI projections', () => {
  it('prints provider health and preserves an advancing empty authorization page', async () => {
    const ctx = new Context()
    const cursor = { nodeId: 'node-a' as never, sequence: 4, effectIndex: 1 }
    const page = { facts: [], complete: false, watermark: 9, nextCursor: cursor, legacyAttribution: 'legacy-unknown' as const }
    const query = vi.fn(async () => page)
    const nodes = [{ nodeId: 'node-a' as never, nodeName: 'node-a', reachable: false, linkState: 'stale' as const,
      observedAt: '2026-01-01T00:00:00Z' as never, status: null, capabilities: [], safeReason: 'unavailable' }]
    ctx.provide('nodeRouter', { status: async () => nodes, route: vi.fn() })
    ctx.provide('seatAuthorizationQueries', { query, tasks: vi.fn() })
    try {
      expect(await executeSeatCommand(ctx, ['nodes', 'list', '--json'])).toEqual({ code: 0, output: nodes })
      expect(await executeSeatCommand(ctx, ['nodes', 'status', '--node', 'node-b'])).toEqual({ code: 0, output: null })
      expect(await executeSeatCommand(ctx, ['authorizations', 'query', '--task', 'task-a', '--limit', '3', '--cursor', JSON.stringify(cursor)]))
        .toEqual({ code: 0, output: page })
      expect(query).toHaveBeenCalledExactlyOnceWith({ taskId: 'task-a', limit: 3, cursor })
      expect((await executeSeatCommand(ctx, ['authorizations', 'query', '--request', '{"limit":1,"principalId":"owner"}'])).code).toBe(2)
      expect(query).toHaveBeenCalledTimes(1)
    } finally { await ctx.fiber.dispose() }
  })
  it('reports unavailable providers without activating a host', async () => {
    const ctx = new Context()
    try { expect((await executeSeatCommand(ctx, ['nodes', 'list'])).code).toBe(2) }
    finally { await ctx.fiber.dispose() }
  })
  it('rebuilds an existing host through its authenticated private directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-existing-host-'))
    const host = new Context(), client = new Context()
    const rebuildTransport = vi.fn(async () => ({ status: 'rebuilt' as const }))
    host.provide('hostAdminTransport', { rebuildTransport })
    try {
      await host.plugin(Admin, { runtime: { directory, nodeId: 'node-a', principalId: 'operator', port: 0,
        maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 8, maxStoreBytes: 65536, maxOperations: 100 } })
      const files = new Admin.PosixPrivateFiles(directory, process.getuid!())
      await expect.poll(() => files.read('endpoint.json', 4096)).not.toBeNull()
      expect((await executeSeatCommand(client, ['nodes', 'rebuild', '--directory', directory])).code).toBe(2)
      expect(rebuildTransport).not.toHaveBeenCalled()
      expect(await executeSeatCommand(client, ['nodes', 'rebuild', '--directory', directory], {
        maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 1,
      }))
        .toEqual({ code: 0, output: { status: 'rebuilt' } })
      expect(rebuildTransport).toHaveBeenCalledOnce()
      expect(client.get('hostAdminTransport')).toBeUndefined()
      const callbacks = new Set<() => void>(), exit = vi.fn()
      client.provide('cmdlineArgs', { get: () => ['nodes', 'rebuild', '--directory', directory], set: () => {} })
      client.provide('appReady', { onReady: (callback) => { callbacks.add(callback); return () => { callbacks.delete(callback) } } })
      client.provide('appExit', exit)
      await client.plugin(Loader)
      Object.assign(client.loader.builtins, { include: Include, app: App })
      const path = join(directory, 'client.cordis.yml')
      await writeFile(path, JSON.stringify([{ name: 'cordis:app', config: { adminClient: {
        maxFrameBytes: 65536, requestTimeoutMs: 1000, maxPending: 1,
      } } }]))
      const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      try {
        await client.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
        await client.loader.await()
        expect(callbacks.size).toBe(1)
        for (const callback of callbacks) callback()
        await expect.poll(() => exit.mock.calls).toEqual([[0]])
        expect(output).toHaveBeenCalledWith('{"status":"rebuilt"}\n')
        expect(rebuildTransport).toHaveBeenCalledTimes(2)
        await client.fiber.dispose()
        expect(callbacks.size).toBe(0)
      } finally { output.mockRestore() }
    } finally {
      await client.fiber.dispose(); await host.fiber.dispose(); await rm(directory, { recursive: true, force: true })
    }
  })
  it('rebuilds the node transport once and refuses extra options', async () => {
    const ctx = new Context()
    const rebuildTransport = vi.fn(async () => ({ status: 'rebuilt' as const }))
    ctx.provide('hostAdminTransport', { rebuildTransport })
    const missing = new Context()
    try {
      expect(await executeSeatCommand(ctx, ['nodes', 'rebuild'])).toEqual({ code: 0, output: { status: 'rebuilt' } })
      expect(rebuildTransport).toHaveBeenCalledOnce()
      expect((await executeSeatCommand(ctx, ['nodes', 'rebuild', '--force'])).code).toBe(2)
      expect(rebuildTransport).toHaveBeenCalledOnce()
      expect((await executeSeatCommand(missing, ['nodes', 'rebuild'])).code).toBe(2)
    } finally { await ctx.fiber.dispose(); await missing.fiber.dispose() }
  })
})
