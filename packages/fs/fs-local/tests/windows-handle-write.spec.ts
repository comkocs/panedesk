import { beforeEach, expect, it, vi } from 'vitest'
import { FsError } from '@panedesk/dsh-fs'
import { loadWindowsWriteModule } from '../src/win32-write-loader.ts'
import type { HandleWriteRequest, WindowsNativeContext, WindowsWriteHandler } from '../src/win32-handle-types.ts'
import { metadata } from './fixtures/windows-directory-api.ts'

const state = vi.hoisted(() => ({ calls: [] as string[], next: 10, progress: 2, fail: '', live: new Set<number>() }))
vi.mock('../src/win32-write-abi.ts', () => ({
  createWindowsWriteApi: () => ({
    security() { state.calls.push('security'); if (state.fail === 'security') throw new FsError('security refused', 'FS_IO_ERROR'); return { directory: Buffer.from('private'), file: Buffer.from('inherited') } },
    createDirectory(_parent: number, _name: string, exclusive: boolean, descriptor: Buffer | null) {
      state.calls.push(exclusive && descriptor ? 'private-directory' : 'directory')
      const token = ++state.next; state.live.add(token); return { kind: 'opened', token, metadata: metadata('C:\\safe', true) }
    },
    createFile() { state.calls.push('empty-file'); const token = ++state.next; state.live.add(token); return token },
    secureEmpty() { state.calls.push('secure'); if (state.fail === 'secure') throw new FsError('secure refused', 'FS_IO_ERROR') },
    inspect() { return metadata('C:\\safe\\stage') },
    read(_token: number, _position: bigint, length: number) { return Buffer.alloc(length) },
    write(_token: number, bytes: Uint8Array) { state.calls.push(`write:${bytes.length}`); return Math.min(bytes.length, state.progress) },
    flush() { state.calls.push('flush'); if (state.fail === 'flush') throw new FsError('flush refused', 'FS_IO_ERROR') },
    link() { state.calls.push('link'); if (state.fail === 'collision') throw new FsError('exists', 'FS_NOT_OBSERVED') },
    disposition() { state.calls.push('disposition'); if (state.fail === 'cleanup') throw new FsError('cleanup refused', 'FS_IO_ERROR') },
    openRemoval() { state.calls.push('open-removal'); const token = ++state.next; state.live.add(token); return token },
    close(token: number) { state.calls.push(`close:${token}`); state.live.delete(token) },
  }),
}))

const context: WindowsNativeContext = {
  get() { return {} },
  adopt() { throw new Error('unexpected adoption') },
  inspect() { return metadata('C:\\safe', true) },
  release() { throw new Error('unexpected release') },
}

async function fixture() {
  const module = await loadWindowsWriteModule()
  const handler: WindowsWriteHandler = module?.createWindowsWriteHandler(context) ?? {
    execute() { throw new FsError('write capability not ready', 'FS_IO_ERROR') }, close() {},
  }
  const target = {
    parent: 1, entry: { kind: 'child' as const, name: 'file' },
    async execute(request: HandleWriteRequest) { return handler.execute(request) },
    async openRead() { throw new Error('unexpected read') },
    async probe() { return null },
  }
  if (!module) throw new FsError('write capability not ready', 'FS_IO_ERROR')
  const extension = module.createWindowsWriteExtension({ ...target, async execute(request) {
    if (request.kind === 'root' || request.kind === 'open' || request.kind === 'inspect' || request.kind === 'read'
      || request.kind === 'enumerate' || request.kind === 'close' || request.kind === 'shutdown') throw new Error('unexpected read request')
    return target.execute(request)
  } })
  return { handler, extension, stage: () => extension.stage(1, 'file', { kind: 'new', inheritFromDestination: true }) }
}

beforeEach(() => { state.calls.length = 0; state.next = 10; state.progress = 2; state.fail = ''; state.live.clear() })

it('secures the empty staging file before writing bytes and completes short writes', async () => {
  const f = await fixture()
  try {
    await f.extension.write('hello', undefined, undefined, {}, { displayPath: 'file' })
    expect(state.calls).toEqual(['empty-file', 'write:5', 'write:3', 'write:1', 'flush', 'link', 'disposition', 'close:11'])
    expect(state.calls.filter(call => call === 'link')).toHaveLength(1)
    expect(state.live.size).toBe(0)
  } finally { await f.handler.close() }
})

it('publishes an empty file only after security and flush', async () => {
  const f = await fixture()
  try {
    await f.extension.write('', undefined, undefined, {}, { displayPath: 'file' })
    expect(state.calls).toEqual(['empty-file', 'flush', 'link', 'disposition', 'close:11'])
  } finally { await f.handler.close() }
})

it.each(['create', 'write', 'flush'])('refuses %s failure without publication and releases ownership', async (failure) => {
  const bindings = await import('../src/win32-write-abi.ts')
  const api = bindings.createWindowsWriteApi(context)
  if (failure === 'create') api.createFile = () => { state.calls.push('create-failed'); throw new FsError('create refused', 'FS_IO_ERROR') }
  if (failure === 'write') api.write = () => { state.calls.push('write-failed'); throw new FsError('write refused', 'FS_IO_ERROR') }
  const factory = vi.spyOn(bindings, 'createWindowsWriteApi').mockReturnValueOnce(api)
  const f = await fixture(); state.fail = failure
  try {
    await expect(f.extension.write('hello', undefined, undefined, {}, { displayPath: 'file' })).rejects.toThrow('refused')
    expect(state.calls.includes('link')).toBe(false)
    if (failure !== 'flush') expect(state.calls.some(call => call.startsWith('write:'))).toBe(false)
    expect(state.live.size).toBe(0)
    expect(state.calls).toEqual(failure === 'create' ? ['create-failed'] : failure === 'write'
      ? ['empty-file', 'write-failed', 'disposition', 'close:11']
      : ['empty-file', 'write:5', 'write:3', 'write:1', 'flush', 'disposition', 'close:11'])
  } finally { factory.mockRestore(); await f.handler.close() }
})

it('refuses zero progress without flush or publication', async () => {
  const f = await fixture(); state.progress = 0
  try {
    await expect(f.extension.write('hello', undefined, undefined, {}, { displayPath: 'file' })).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(state.calls.includes('flush')).toBe(false)
    expect(state.calls.includes('link')).toBe(false)
    expect(state.live.size).toBe(0)
  } finally { await f.handler.close() }
})

it('observes cancellation before publication and discards the owned stage', async () => {
  const f = await fixture(); const stage = await f.stage(); const controller = new AbortController()
  try {
    await stage.file.flush(); await stage.prepareMetadata(); controller.abort()
    await expect(stage.publish({ kind: 'create-if-absent', displayPath: 'file' }, controller.signal)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(state.calls.includes('link')).toBe(false)
  } finally { await stage.close(); await f.handler.close() }
  expect(state.live.size).toBe(0)
})

it('refuses publication before flush and metadata preparation', async () => {
  const f = await fixture(); const stage = await f.stage()
  try {
    await expect(stage.publish({ kind: 'create-if-absent', displayPath: 'file' })).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(state.calls.includes('link')).toBe(false)
  } finally { await stage.close(); await f.handler.close() }
})

it('preserves a concurrent creator during no-replace publication', async () => {
  const f = await fixture(); state.fail = 'collision'
  try {
    await expect(f.extension.write('hello', undefined, undefined, {}, { displayPath: 'file' })).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    expect(state.calls.filter(call => call === 'link')).toHaveLength(1)
    expect(state.live.size).toBe(0)
  } finally { await f.handler.close() }
})

it('keeps committed publication successful when private cleanup fails', async () => {
  const f = await fixture(); state.fail = 'cleanup'
  try {
    await expect(f.extension.write('hello', undefined, undefined, {}, { displayPath: 'file' })).resolves.toBeUndefined()
    expect(state.calls.filter(call => call === 'link')).toHaveLength(1)
    expect(state.live.size).toBe(0)
  } finally { await f.handler.close() }
})

it('discards uncommitted stages exactly once and rejects use after close', async () => {
  const f = await fixture(); const stage = await f.stage()
  await Promise.all([stage.close(), stage.close()]); await f.handler.close()
  await expect(stage.file.write(Buffer.from('x'), 0, 1, 0n)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  expect(state.calls.filter(call => call.startsWith('close:'))).toEqual(['close:11'])
  expect(state.live.size).toBe(0)
})

it('deletes through disposition and closes its opened handle', async () => {
  const f = await fixture()
  try {
    await f.extension.remove()
    expect(state.calls).toEqual(['open-removal', 'disposition', 'close:11'])
    expect(state.live.size).toBe(0)
  } finally { await f.handler.close() }
})
