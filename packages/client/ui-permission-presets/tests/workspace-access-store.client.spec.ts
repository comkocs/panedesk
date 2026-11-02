import { Context } from '@panedesk/cordis'
import { expect, it, vi } from 'vitest'
import type { ConnectionGeneration, ConnectionHandle } from '@panedesk/dsh-client-connection/client'
import { TestRemote } from '@panedesk/dsh-client-test-runtime'
import { WorkspaceAccessController } from '../src/client/workspace-access-store.ts'

it.each(['replace', 'dispose'] as const)('does not authorize a directory after %s while the picker is open', async (action) => {
  const ctx = new Context()
  let generation: ConnectionGeneration | undefined = { id: 1, host: { home: '/first' } }
  const connection: Partial<ConnectionHandle> = {
    isLoopback: true,
    generation: { getSnapshot: () => generation, subscribe: () => () => {} },
  }
  ctx.provide('connection', connection as ConnectionHandle)
  const selected = Promise.withResolvers<{ ok: true; value: string | null }>()
  const authorize = vi.fn(async () => ({ ok: true as const, value: undefined }))
  new TestRemote(ctx, {
    directoryPicker: { pick: () => selected.promise },
    permissionPresets: {
      authorizeWorkspaceWrite: authorize,
      workspaceWriteAccess: async () => ({ ok: true as const, value: { supported: true, entries: [] } }),
    },
  })
  const controller = new WorkspaceAccessController(ctx)
  const pending = controller.selectDirectory()
  if (action === 'replace') generation = { id: 2, host: { home: '/second' } }
  else controller.dispose()
  selected.resolve({ ok: true, value: 'C:\\project' })
  await pending
  expect(authorize).not.toHaveBeenCalled()
  controller.dispose()
})

it('clears the previous inventory on connection replacement and unsubscribes on disposal', async () => {
  const ctx = new Context()
  let generation: ConnectionGeneration | undefined = { id: 1, host: { home: '/first' } }
  let changed: () => void = () => {}
  const unsubscribe = vi.fn()
  const connection: Partial<ConnectionHandle> = {
    generation: {
      getSnapshot: () => generation,
      subscribe: (listener) => { changed = listener; return unsubscribe },
    },
  }
  ctx.provide('connection', connection as ConnectionHandle)
  new TestRemote(ctx, {
    permissionPresets: {
      workspaceWriteAccess: async () => ({ ok: true as const, value: {
        supported: true,
        entries: [{ workspace: 'C:\\project', source: 'legacy' as const }],
      } }),
    },
  })
  const controller = new WorkspaceAccessController(ctx)
  await controller.load()
  expect(controller.store.getSnapshot().entries).toHaveLength(1)
  generation = undefined
  changed()
  expect(controller.store.getSnapshot()).toEqual({ status: 'idle', supported: false, entries: [], error: null })
  controller.dispose()
  controller.dispose()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('discards an inventory response from a replaced connection', async () => {
  const ctx = new Context()
  let generation: ConnectionGeneration | undefined = { id: 1, host: { home: '/first' } }
  const connection: Partial<ConnectionHandle> = {
    generation: { getSnapshot: () => generation, subscribe: () => () => {} },
  }
  ctx.provide('connection', connection as ConnectionHandle)
  const inventory = Promise.withResolvers<{ ok: true; value: { supported: boolean; entries: [] } }>()
  const requested = Promise.withResolvers<undefined>()
  new TestRemote(ctx, {
    permissionPresets: {
      workspaceWriteAccess: () => { requested.resolve(undefined); return inventory.promise },
    },
  })
  const controller = new WorkspaceAccessController(ctx)
  const pending = controller.load()
  await requested.promise
  generation = { id: 2, host: { home: '/second' } }
  inventory.resolve({ ok: true, value: { supported: true, entries: [] } })
  await pending
  expect(controller.store.getSnapshot().supported).toBe(false)
  expect(controller.store.getSnapshot().status).not.toBe('ready')
  controller.dispose()
})

it('refreshes workspace access after a host notification and stops after disposal', async () => {
  const ctx = new Context()
  const generation: ConnectionGeneration = { id: 1, host: { home: '/first' } }
  const connection: Partial<ConnectionHandle> = {
    generation: { getSnapshot: () => generation, subscribe: () => () => {} },
  }
  ctx.provide('connection', connection as ConnectionHandle)
  const inventory = vi.fn(async () => ({ ok: true as const, value: { supported: true, entries: [] } }))
  const remote = new TestRemote(ctx, { permissionPresets: { workspaceWriteAccess: inventory } })
  const controller = new WorkspaceAccessController(ctx)
  await controller.load()
  remote.emit('permission-presets/workspace-write-changed', [])
  await vi.waitFor(() => { expect(inventory).toHaveBeenCalledTimes(2) })
  controller.dispose()
  remote.emit('permission-presets/workspace-write-changed', [])
  await Promise.resolve()
  expect(inventory).toHaveBeenCalledTimes(2)
})

it('re-reads an inventory invalidated while its first read is pending', async () => {
  const ctx = new Context()
  const generation: ConnectionGeneration = { id: 1, host: { home: '/first' } }
  const connection: Partial<ConnectionHandle> = {
    generation: { getSnapshot: () => generation, subscribe: () => () => {} },
  }
  ctx.provide('connection', connection as ConnectionHandle)
  const first = Promise.withResolvers<{ ok: true; value: { supported: boolean; entries: [] } }>()
  const requested = Promise.withResolvers<undefined>()
  let calls = 0
  const remote = new TestRemote(ctx, { permissionPresets: { workspaceWriteAccess: async () => {
    calls += 1
    if (calls === 1) {
      requested.resolve(undefined)
      return first.promise
    }
    return { ok: true as const, value: { supported: true, entries: [] } }
  } } })
  const controller = new WorkspaceAccessController(ctx)
  const loading = controller.load()
  await requested.promise
  remote.emit('permission-presets/workspace-write-changed', [])
  first.resolve({ ok: true, value: { supported: true, entries: [] } })
  await loading
  await vi.waitFor(() => { expect(calls).toBe(2) })
  controller.dispose()
})

it('does not call a remote without an active connection', async () => {
  const ctx = new Context()
  const connection: Partial<ConnectionHandle> = {
    isLoopback: true,
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
  }
  ctx.provide('connection', connection as ConnectionHandle)
  const revoke = vi.fn(async () => ({ ok: true as const, value: undefined }))
  new TestRemote(ctx, {
    permissionPresets: {
      revokeWorkspaceWrite: revoke,
      workspaceWriteAccess: async () => ({ ok: true as const, value: { supported: true, entries: [] } }),
    },
  })
  const controller = new WorkspaceAccessController(ctx)
  await controller.revoke('C:\\project')
  expect(revoke).not.toHaveBeenCalled()
  expect(controller.store.getSnapshot().status).toBe('error')
  controller.dispose()
})
