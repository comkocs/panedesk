import koffi from 'koffi'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import { FsTargetKey } from '@panedesk/dsh-fs'
import { LocalFileSystem } from '../src/index.ts'
import { createHandleExecutor } from '../src/win32-handle-executor.ts'
import { createWindowsWriteHandler } from '../src/win32-write-backend.ts'
import type { HandleExecutor, WindowsNativeContext } from '../src/win32-handle-types.ts'
import { metadata } from './fixtures/windows-directory-api.ts'

const native = vi.hoisted(() => ({ functions: new Map<string, (...args: never[]) => unknown>(), paths: [] as string[] }))
vi.mock('koffi', async (original) => {
  const actual = await original<typeof import('koffi')>()
  return { default: { ...actual.default, load: () => ({ func(declaration: string) {
    const name = declaration.match(/__stdcall (\w+)/)?.[1]
    const fn = name && native.functions.get(name)
    if (!fn) throw new Error(`Unexpected native binding: ${name}`)
    return fn
  } }) } }
})
vi.mock('../src/win32-handle-executor.ts', () => ({ createHandleExecutor: vi.fn() }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  const refuse = (name: string) => () => { native.paths.push(name); throw new Error('Unexpected path mutation') }
  return { ...actual, open: refuse('open'), writeFile: refuse('writeFile'), rename: refuse('rename'),
    link: refuse('link'), unlink: refuse('unlink'), mkdir: refuse('mkdir') }
})
afterEach(() => vi.restoreAllMocks())

class AuthorizedFileSystem extends LocalFileSystem {
  protected override writeRoot(): Promise<string> { return Promise.resolve('C:\\safe') }
}

type Failure = '' | 'create' | 'write' | 'flush' | 'link' | 'collision'

async function fixture(failure: Failure = '', lowIntegrity = false, exists = false) {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.spyOn(process, 'arch', 'get').mockReturnValue('x64')
  native.functions.clear(); native.paths.length = 0
  const events: string[] = []
  const handles = new Map<number, object>()
  const root = Buffer.alloc(8)
  const parent = Buffer.alloc(8)
  const parentPolicy = { dacl: [{ objectInherit: true, access: 'read-write' }],
    label: lowIntegrity ? { level: 'low', objectInherit: true, containerInherit: true } : null }
  const inherited = { owner: 'caller', group: 'primary', dacl: [{ inherited: true, access: 'read-write' }],
    label: lowIntegrity ? { level: 'low', inherited: true } : null }
  // Model the ordinary kernel-create result, not a production permission synthesizer.
  const ordinary = structuredClone(inherited)
  const files = new Map<object, { bytes: Buffer; permissions: typeof inherited; temporary: boolean; position: number }>()
  let published: object | undefined
  let target = exists ? Buffer.from('existing') : undefined
  let next = 2
  const getFile = (handle: object) => {
    const file = files.get(handle)
    if (!file) throw new Error('Missing file')
    return file
  }
  const context: WindowsNativeContext = {
    get(token) { const handle = handles.get(token); if (!handle) throw new Error('Closed handle'); return handle },
    inspect(handle) {
      const file = files.get(handle)
      return { ...metadata(file ? 'C:\\safe\\entry' : 'C:\\safe', !file), size: file?.bytes.length ?? 0 }
    },
    adopt(handle) { const token = ++next; handles.set(token, handle); return { kind: 'opened', token, metadata: this.inspect(handle) } },
    release(token) { expect(handles.delete(token)).toBe(true); events.push(`close:${token}`) },
  }
  const bind = (name: string, fn: (...args: never[]) => unknown) => native.functions.set(name, fn)
  for (const name of ['OpenProcessToken', 'GetTokenInformation', 'GetCurrentProcess', 'NtQuerySecurityObject', 'NtSetSecurityObject', 'ReadFile', 'NtWaitForSingleObject']) {
    bind(name, () => { throw new Error(`Unexpected new-file operation: ${name}`) })
  }
  bind('CloseHandle', () => 1)
  bind('GetLastError', () => 5)
  bind('NtCreateFile', (out: [object | null], access: number, attributes: Buffer, _iosb: Buffer,
    _size: null, flags: number, share: number, disposition: number, options: number) => {
    expect(attributes.readBigUInt64LE(8)).toBe(koffi.address(parent))
    expect(koffi.decode(attributes, 32, 'void *')).toBeNull()
    expect({ access, flags, share, disposition, options }).toEqual({
      access: 0x13019f, flags: 0, share: 0, disposition: 2, options: 0x200060,
    })
    const unicode = koffi.decode(attributes, 16, 'void *') as object
    const length = koffi.decode(unicode, 0, 'uint16_t') as number
    const text = koffi.decode(unicode, 8, 'void *') as object
    const name = Buffer.from(koffi.decode(text, 'uint8_t', length) as number[]).toString('utf16le')
    expect(name).toMatch(/^\.stage-[0-9a-f-]{36}$/u)
    events.push('create')
    if (failure === 'create') return 0xc0000022
    const handle = Buffer.alloc(8)
    files.set(handle, { bytes: Buffer.alloc(0), permissions: { owner: 'caller', group: 'primary',
      dacl: parentPolicy.dacl.filter(ace => ace.objectInherit).map(ace => ({ inherited: true, access: ace.access })),
      label: parentPolicy.label?.objectInherit ? { level: parentPolicy.label.level, inherited: true } : null },
    temporary: true, position: 0 })
    out[0] = handle
    return 0
  })
  bind('SetFilePointerEx', (handle: object, offset: bigint) => { getFile(handle).position = Number(offset); return 1 })
  bind('WriteFile', (handle: object, bytes: Uint8Array, length: number, count: [number]) => {
    events.push(`write:${length}`)
    if (failure === 'write') return 0
    const file = getFile(handle)
    expect(file.permissions).toEqual(ordinary)
    count[0] = Math.min(length, 2)
    expect(file.position).toBe(file.bytes.length)
    file.bytes = Buffer.concat([file.bytes, bytes.subarray(0, count[0])])
    return 1
  })
  bind('FlushFileBuffers', () => { events.push('flush'); return failure === 'flush' ? 0 : 1 })
  bind('NtSetInformationFile', (handle: object, _iosb: Buffer, buffer: Buffer, _length: number, information: number) => {
    if (information === 11) {
      expect(events.slice(-2)).toEqual(['flush', 'ready'])
      expect(buffer.readUInt8(0)).toBe(0)
      expect(buffer.readBigUInt64LE(8)).toBe(koffi.address(parent))
      expect(buffer.subarray(20, 20 + buffer.readUInt32LE(16)).toString('utf16le')).toBe('entry')
      events.push('link')
      if (failure === 'collision') { target = Buffer.from('existing'); return 0xc0000035 }
      if (failure === 'link') return 0xc0000022
      expect(target).toBeUndefined()
      published = handle; target = Buffer.from(getFile(handle).bytes)
    } else {
      expect(information).toBe(13)
      expect(buffer.readUInt8(0)).toBe(1)
      events.push('disposition')
      getFile(handle).temporary = false
      if (published !== handle) files.delete(handle)
    }
    return 0
  })
  const handler = createWindowsWriteHandler(context)
  const executor: HandleExecutor = {
    async execute(request) {
      switch (request.kind) {
        case 'root': handles.set(1, root); return { kind: 'opened', token: 1, metadata: metadata('C:\\', true) }
        case 'open':
          if (request.name === 'safe') { handles.set(2, parent); return { kind: 'opened', token: 2, metadata: metadata('C:\\safe', true) } }
          if (!target) throw Object.assign(new Error('Missing file'), { code: 'ENOENT' })
          { const token = ++next; handles.set(token, published ?? Buffer.alloc(8))
            return { kind: 'opened', token, metadata: { ...metadata('C:\\safe\\entry'), size: target.length } } }
        case 'close': context.release(request.token); return { kind: 'closed' }
        case 'inspect': case 'read': case 'enumerate': case 'shutdown': throw new Error('Unexpected read request')
        default: {
          const reply = await handler.execute(request)
          if (request.kind === 'prepare-metadata') events.push('ready')
          return reply
        }
      }
    },
    async close() { try { await handler.close() } finally { for (const token of [...handles.keys()].reverse()) context.release(token) } },
  }
  vi.mocked(createHandleExecutor).mockReturnValue(executor)
  const ctx = new Context()
  const fiber = await ctx.plugin(AuthorizedFileSystem, { cwd: 'C:\\safe', windowsHandleBackend: 'experimental' })
  const destination = { targetKey: FsTargetKey('C:\\safe\\entry'), displayPath: 'entry' }
  return { events, handles, files, ordinary, write: (content: string) => ctx.fs.writeText(destination, content, { kind: 'createIfAbsent' }),
    target: () => target, permissions: () => published ? getFile(published).permissions : undefined,
    async close() { try { await executor.close() } finally { await fiber.dispose() } } }
}

it.each([false, true])('creates a file with ordinary destination inheritance (low integrity: %s)', async (lowIntegrity) => {
  const f = await fixture('', lowIntegrity)
  try {
    expect(await f.write('hello')).toEqual({ operation: 'create', version: metadata('entry').version, before: null, after: 'hello' })
    expect(f.target()?.toString()).toBe('hello')
    expect(f.permissions()).toEqual(f.ordinary)
    expect(f.events).toEqual(['create', 'write:5', 'write:3', 'write:1', 'flush', 'ready', 'link', 'disposition', 'close:3', 'close:4', 'close:2', 'close:1'])
    expect([...f.files.values()].map(file => file.temporary)).toEqual([false])
    expect(f.handles.size).toBe(0)
    expect(native.paths).toEqual([])
  } finally { await f.close() }
})

it('flushes an empty file before no-replace publication', async () => {
  const f = await fixture()
  try {
    expect((await f.write('')).operation).toBe('create')
    expect(f.target()).toEqual(Buffer.alloc(0))
    expect(f.events).toEqual(['create', 'flush', 'ready', 'link', 'disposition', 'close:3', 'close:4', 'close:2', 'close:1'])
    expect(f.handles.size).toBe(0)
    expect(native.paths).toEqual([])
  } finally { await f.close() }
})

it.each(['create', 'write', 'flush', 'link'] as const)('cleans up %s failure without publishing or retaining writes', async (failure) => {
  const f = await fixture(failure)
  const prefixes = { create: ['create'], write: ['create', 'write:5'],
    flush: ['create', 'write:5', 'write:3', 'write:1', 'flush'],
    link: ['create', 'write:5', 'write:3', 'write:1', 'flush', 'ready', 'link'] }
  try {
    await expect(f.write('hello')).rejects.toHaveProperty('code', 'FS_PERMISSION_DENIED')
    expect(f.target()).toBeUndefined()
    expect(f.files.size).toBe(0)
    expect(f.handles.size).toBe(0)
    expect(f.events).toEqual([...prefixes[failure], ...(failure === 'create' ? [] : ['disposition', 'close:3']), 'close:2', 'close:1'])
    expect(native.paths).toEqual([])
  } finally { await f.close() }
})

it.each([false, true])('preserves an existing target (present before probe: %s)', async (exists) => {
  const f = await fixture(exists ? '' : 'collision', false, exists)
  try {
    await expect(f.write('hello')).rejects.toHaveProperty('code', 'FS_NOT_OBSERVED')
    expect(f.target()?.toString()).toBe('existing')
    expect(f.files.size).toBe(0)
    expect(f.handles.size).toBe(0)
    expect(f.events).toEqual(exists ? ['close:3', 'close:2', 'close:1']
      : ['create', 'write:5', 'write:3', 'write:1', 'flush', 'ready', 'link', 'disposition', 'close:3', 'close:2', 'close:1'])
    expect(native.paths).toEqual([])
  } finally { await f.close() }
})
