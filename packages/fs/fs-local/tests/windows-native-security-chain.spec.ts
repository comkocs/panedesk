import koffi from 'koffi'
import { afterEach, expect, it, vi } from 'vitest'
import { createWindowsWriteApi } from '../src/win32-write-abi.ts'
import { createStageHandler } from '../src/win32-stage.ts'
import type { WindowsNativeContext } from '../src/win32-handle-types.ts'
import { metadata } from './fixtures/windows-directory-api.ts'
import { ace, acl, descriptor, syntheticSid } from './fixtures/windows-security.ts'

const native = vi.hoisted(() => ({ functions: new Map<string, (...args: never[]) => unknown>(),
  declarations: [] as string[], paths: [] as string[] }))
vi.mock('koffi', async (original) => {
  const actual = await original<typeof import('koffi')>()
  return { default: { ...actual.default, load: () => ({ func(declaration: string) {
    native.declarations.push(declaration)
    const name = declaration.match(/__stdcall (\w+)/)?.[1]
    const fn = name && native.functions.get(name)
    if (!fn) throw new Error(`Unexpected native binding: ${name}`)
    return fn
  } }) } }
})
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: () => { native.paths.push('writeFile'); throw new Error('Path write') },
    rename: () => { native.paths.push('rename'); throw new Error('Path rename') } }
})
afterEach(() => vi.restoreAllMocks())

function fixture(kind = 'inherited') {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.spyOn(process, 'arch', 'get').mockReturnValue('x64')
  native.functions.clear(); native.declarations.length = 0; native.paths.length = 0
  const user = syntheticSid(101)
  const group = syntheticSid(103)
  const inherited = descriptor(0x8404, user, group, acl([ace(0, 0x10, 0x1f01ff, user)]))
  const previous = Buffer.from(kind === 'integrity' || kind === 'inherited-label'
    ? descriptor(0x8414, user, group, acl([ace(0, 0x10, 0x1f01ff, user)]),
      acl([ace(17, kind === 'inherited-label' ? 0x10 : 0, 0, syntheticSid(104))]))
    : inherited)
  if (kind === 'explicit') previous[previous.readUInt32LE(16) + 9] = 0
  if (kind === 'protected') previous.writeUInt16LE(0x9404, 2)
  if (kind === 'owner' || kind === 'elevated-owner') syntheticSid(102).copy(previous, previous.readUInt32LE(4))
  const events: string[] = []
  const handles = new Map<number, Buffer>([[1, Buffer.alloc(8)]])
  const policies = new Map<object, Buffer>()
  let sequence = 1
  let target = 'old'
  let content = ''
  let tokens = 0
  const root = handles.get(1)!
  policies.set(root, inherited)
  const context: WindowsNativeContext = {
    get(token) { const value = handles.get(token); if (!value) throw new Error('Closed token'); return value },
    inspect(handle) { const token = [...handles].find(([, value]) => value === handle)?.[0]
      return { ...metadata('C:\\synthetic\\entry', token === 1), size: token === 3 ? content.length : 4 } },
    adopt(handle) { if (!Buffer.isBuffer(handle)) throw new Error('Unexpected handle')
      const token = ++sequence; handles.set(token, handle)
      policies.set(handle, token === 2 ? previous : inherited)
      return { kind: 'opened', token, metadata: context.inspect(handle) } },
    release(token) { handles.delete(token) },
  }
  const bind = (name: string, fn: (...args: never[]) => unknown) => native.functions.set(name, fn)
  bind('OpenProcessToken', (_process: object, _access: number, out: [object | null]) => { out[0] = Buffer.alloc(8); tokens++; return 1 })
  bind('GetTokenInformation', (_token: object, information: number, buffer: Buffer | null, _length: number, needed: [number]) => {
    needed[0] = 16 + user.length
    if (!buffer) return 0
    const sid = kind === 'elevated-owner' && information === 4 ? syntheticSid(102) : user
    sid.copy(buffer, 16); koffi.encode(buffer, 'void *', koffi.as(buffer.subarray(16), 'void *')); return 1
  })
  bind('GetCurrentProcess', () => root)
  bind('CloseHandle', (handle: object) => { if (handle !== root) tokens--; return 1 })
  bind('ReOpenFile', () => root)
  bind('NtCreateFile', (out: [object | null], access: number, attributes: Buffer, _iosb: Buffer,
    _size: null, _flags: number, _share: number, disposition: number) => {
    if (disposition === 1) events.push(`open:${(access >>> 0).toString(16)}`)
    if (disposition === 2) {
      expect(attributes.readBigUInt64LE(8)).toBe(koffi.address(root))
      expect(koffi.decode(attributes, 32, 'void *')).toBeNull()
      events.push('same-directory-create')
    }
    out[0] = Buffer.alloc(8); return 0
  })
  bind('NtQuerySecurityObject', (handle: object, information: number, buffer: Buffer, length: number, needed: [number]) => {
    events.push(`query:${(information >>> 0).toString(16)}`)
    if (kind === 'query-failure' && information !== 0x20) return 0xc0000022
    let bytes = information === 0x20 ? Buffer.from([1, 0, 0, 128, ...Array<number>(16).fill(0)]) : policies.get(handle)!
    if (kind === 'requested' && information !== 0x20 && (information & 0x04) === 0) {
      bytes = Buffer.from(bytes)
      bytes.writeUInt16LE(bytes.readUInt16LE(2) & ~0x04, 2)
      bytes.writeUInt32LE(0, 16)
    }
    needed[0] = bytes.length
    if (length < bytes.length) return 0xc0000023
    bytes.copy(buffer); events.push('query'); return 0
  })
  bind('NtSetSecurityObject', () => { events.push('set-security'); return 0 })
  bind('GetFileInformationByHandleEx', (_handle: object, information: number, buffer: Buffer) => { buffer.writeUInt32LE(32, information === 0 ? 32 : 0); return 1 })
  bind('DeviceIoControl', (_handle: object, code: number, _input: Buffer | null, _inputLength: number, output: Buffer | null, _outputLength: number, count: [number]) => {
    if (code === 0x9003c) { output!.writeUInt16LE(0); count[0] = 2 } return 1
  })
  bind('BackupRead', (_handle: object, _buffer: Buffer, _length: number, count: [number]) => { count[0] = 0; return 1 })
  bind('BackupWrite', () => { throw new Error('Unexpected stream write') })
  bind('SetFilePointerEx', () => 1)
  bind('WriteFile', (_handle: object, bytes: Uint8Array, length: number, count: [number]) => {
    expect(events).toContain('same-directory-create'); expect(target).toBe('old')
    content = Buffer.from(bytes).toString(); count[0] = length; events.push('write'); return 1
  })
  bind('ReadFile', (_handle: object, buffer: Buffer, length: number, count: [number]) => {
    const bytes = Buffer.from(content); bytes.copy(buffer, 0, 0, length); count[0] = Math.min(length, bytes.length); return 1
  })
  bind('FlushFileBuffers', () => { events.push('flush'); return 1 })
  bind('GetLastError', () => 5)
  bind('NtWaitForSingleObject', () => 0)
  bind('NtSetInformationFile', (_handle: object, _iosb: Buffer, buffer: Buffer, _length: number, information: number) => {
    if (information === 65) { expect(buffer.readUInt32LE()).toBe(3); target = content; events.push('rename') }
    else if (information !== 4 && information !== 13) throw new Error('Unexpected publication')
    return 0
  })
  const api = createWindowsWriteApi(context)
  const handler = createStageHandler(api)
  return { api, handler, handles, events, target: () => target, tokens: () => tokens, previous, original: Buffer.from(previous) }
}

it('replaces an entirely inherited file in its own directory and leaves readable content', async () => {
  const f = fixture()
  try {
    const stage = await f.handler.execute({ kind: 'stage', parent: 1, name: 'entry', policy: { kind: 'replace', observed: metadata('C:\\synthetic\\entry') } })
    if (stage.kind !== 'staged') throw new Error('Missing stage')
    await f.handler.execute({ kind: 'write', token: stage.token, bytes: Buffer.from('new'), position: 0n })
    await f.handler.execute({ kind: 'flush', token: stage.token })
    await f.handler.execute({ kind: 'prepare-metadata', token: stage.token })
    await f.handler.execute({ kind: 'publish', token: stage.token, request: { kind: 'replace', observed: metadata('C:\\synthetic\\entry'), metadataProfile: 'replacement' } })
    expect(Buffer.from(f.api.read(3, 0n, 3)).toString()).toBe('new')
    await f.handler.execute({ kind: 'stage-close', token: stage.token })
    expect(f.target()).toBe('new')
    expect(f.events).toContain('rename')
    expect(f.events).not.toContain('synthesis')
    expect(f.events).not.toContain('set-security')
    expect(f.handles.size).toBe(1)
    expect(f.tokens()).toBe(0)
    expect(native.paths).toEqual([])
    expect(native.declarations.some(value =>
      /ReplaceFileW|MoveFile|SetFileInformationByHandle|CreatePrivateObjectSecurityEx|DestroyPrivateObjectSecurity/.test(value),
    )).toBe(false)
  } finally { await f.handler.close() }
})

it('replaces an inherited file owned by the elevated token default owner rather than its user', async () => {
  const f = fixture('elevated-owner')
  try {
    const stage = await f.handler.execute({ kind: 'stage', parent: 1, name: 'entry', policy: { kind: 'replace', observed: metadata('C:\\synthetic\\entry') } })
    if (stage.kind !== 'staged') throw new Error('Missing stage')
    await f.handler.execute({ kind: 'write', token: stage.token, bytes: Buffer.from('new'), position: 0n })
    await f.handler.execute({ kind: 'flush', token: stage.token })
    await f.handler.execute({ kind: 'prepare-metadata', token: stage.token })
    await f.handler.execute({ kind: 'publish', token: stage.token, request: { kind: 'replace', observed: metadata('C:\\synthetic\\entry'), metadataProfile: 'replacement' } })
    expect(Buffer.from(f.api.read(3, 0n, 3)).toString()).toBe('new')
    await f.handler.execute({ kind: 'stage-close', token: stage.token })
    expect(f.target()).toBe('new')
    expect(f.events).toContain('rename')
    expect(f.events).not.toContain('set-security')
    expect(f.handles.size).toBe(1)
    expect(f.tokens()).toBe(0)
    expect(native.paths).toEqual([])
    expect(native.declarations.some(value =>
      /ReplaceFileW|MoveFile|SetFileInformationByHandle|CreatePrivateObjectSecurityEx|DestroyPrivateObjectSecurity/.test(value),
    )).toBe(false)
  } finally { await f.handler.close() }
})

it('replaces a file whose integrity label was inherited from its directory', async () => {
  const f = fixture('inherited-label')
  try {
    const stage = await f.handler.execute({ kind: 'stage', parent: 1, name: 'entry', policy: { kind: 'replace', observed: metadata('C:\\synthetic\\entry') } })
    if (stage.kind !== 'staged') throw new Error('Missing stage')
    await f.handler.execute({ kind: 'write', token: stage.token, bytes: Buffer.from('new'), position: 0n })
    await f.handler.execute({ kind: 'flush', token: stage.token })
    await f.handler.execute({ kind: 'prepare-metadata', token: stage.token })
    await f.handler.execute({ kind: 'publish', token: stage.token, request: { kind: 'replace', observed: metadata('C:\\synthetic\\entry'), metadataProfile: 'replacement' } })
    await f.handler.execute({ kind: 'stage-close', token: stage.token })
    expect(f.target()).toBe('new')
    expect(f.events).toContain('rename')
    expect(f.events).not.toContain('set-security')
    expect(native.paths).toEqual([])
  } finally { await f.handler.close() }
})

it('replaces an inherited file when the query returns only requested information', async () => {
  const f = fixture('requested')
  try {
    const stage = await f.handler.execute({ kind: 'stage', parent: 1, name: 'entry', policy: { kind: 'replace', observed: metadata('C:\\synthetic\\entry') } })
    if (stage.kind !== 'staged') throw new Error('Missing stage')
    await f.handler.execute({ kind: 'write', token: stage.token, bytes: Buffer.from('new'), position: 0n })
    await f.handler.execute({ kind: 'flush', token: stage.token })
    await f.handler.execute({ kind: 'prepare-metadata', token: stage.token })
    await f.handler.execute({ kind: 'publish', token: stage.token, request: { kind: 'replace', observed: metadata('C:\\synthetic\\entry'), metadataProfile: 'replacement' } })
    await f.handler.execute({ kind: 'stage-close', token: stage.token })
    expect(f.target()).toBe('new')
  } finally { await f.handler.close() }
})

it('opens the old file without ACCESS_SYSTEM_SECURITY and queries no audit information', async () => {
  const f = fixture()
  try {
    await f.handler.execute({ kind: 'stage', parent: 1, name: 'entry', policy: { kind: 'replace', observed: metadata('C:\\synthetic\\entry') } })
    expect(f.events).toContain('open:120089')
    expect(f.events.some(value => value.startsWith('query:'))).toBe(true)
    expect(f.events.filter(value => value.startsWith('query:')).every(value => (Number.parseInt(value.slice(6), 16) & 0x08) === 0)).toBe(true)
    expect(f.events.filter(value => value.startsWith('query:') && value !== 'query:20')).toEqual(['query:17', 'query:17'])
  } finally { await f.handler.close() }
})

it.each(['explicit', 'protected', 'owner', 'query-failure', 'integrity'])('refuses %s permissions with bilingual reason and no target or path write', async (kind) => {
  const f = fixture(kind)
  try {
    await expect(async () => f.handler.execute({ kind: 'stage', parent: 1, name: 'entry', policy: { kind: 'replace', observed: metadata('C:\\synthetic\\entry') } }))
      .rejects.toThrow('This file has individually configured permissions; direct replacement is not supported yet / 该文件有单独设置的权限，暂不支持直接覆盖')
    expect(f.target()).toBe('old')
    expect(f.previous).toEqual(f.original)
    expect(f.events).not.toContain('same-directory-create')
    expect(f.events).not.toContain('write')
    expect(f.handles.size).toBe(1)
    expect(f.tokens()).toBe(0)
    expect(native.paths).toEqual([])
    expect(native.declarations.some(value => /ReplaceFileW|MoveFile|SetFileInformationByHandle/.test(value))).toBe(false)
  } finally { await f.handler.close() }
})
