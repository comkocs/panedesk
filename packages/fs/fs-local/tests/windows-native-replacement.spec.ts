import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WindowsNativeContext } from '../src/win32-handle-types.ts'
import { createWindowsWriteApi } from '../src/win32-write-abi.ts'
import { metadata } from './fixtures/windows-directory-api.ts'

const state = vi.hoisted(() => ({ declarations: [] as string[], information: [] as number[], flags: [] as number[],
  status: 0, target: 'old', paths: [] as string[], missing: '' }))
vi.mock('koffi', async (original) => {
  const actual = await original<typeof import('koffi')>()
  return { default: { ...actual.default, load: (library: string) => ({ func: (declaration: string) => {
    state.declarations.push(`${library}:${declaration}`)
    if (state.missing && declaration.includes(state.missing)) throw new Error('missing export')
    if (declaration.includes('NtSetInformationFile(')) return (_handle: object, _iosb: Buffer, data: Buffer, _length: number, information: number) => {
      state.information.push(information); state.flags.push(data.readUInt32LE(0))
      if (state.status === 0) state.target = 'new'
      return state.status
    }
    if (/ReplaceFileW|MoveFile|SetFileInformationByHandle/.test(declaration)) return () => { state.paths.push(declaration); return 1 }
    return () => 1
  } }) } }
})

const handle = Buffer.alloc(8)
const context: WindowsNativeContext = {
  get: () => handle,
  inspect: () => metadata('C:\\safe', true),
  adopt() { throw new Error('Unexpected adoption') },
  release() { throw new Error('Unexpected release') },
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.spyOn(process, 'arch', 'get').mockReturnValue('x64')
  state.declarations.length = 0; state.information.length = 0; state.flags.length = 0
  state.status = 0; state.target = 'old'; state.paths.length = 0; state.missing = ''
})
afterEach(() => vi.restoreAllMocks())

function replace(): void {
  const api = createWindowsWriteApi(context)
  // Keep the pre-implementation failure behavioral rather than a missing-module import error.
  if (!('replace' in api) || typeof api.replace !== 'function') throw new Error('Native replacement capability unavailable')
  api.replace(1, 2, 'target')
}

it('uses Native POSIX replacement with no Win32 rename or path fallback', () => {
  replace()
  expect(state.information).toEqual([65])
  expect(state.flags).toEqual([3])
  expect(state.target).toBe('new')
  expect(state.paths).toEqual([])
  expect(state.declarations.some(value => /ReplaceFileW|MoveFile|SetFileInformationByHandle/.test(value))).toBe(false)
})

it('refuses an occupied target in both languages without changing it or falling back', () => {
  state.status = 0xc0000022
  expect(replace).toThrow('File is in use by another program; close it and retry / 文件被其他程序占用，请关闭后重试')
  expect(state.information).toEqual([65])
  expect(state.flags).toEqual([3])
  expect(state.target).toBe('old')
  expect(state.paths).toEqual([])
})

it.each([0xc0000003, 0xc00000bb, 0xc0000043])('refuses Native status %i without changing the target or falling back', (status) => {
  state.status = status
  expect(replace).toThrow('句柄操作失败')
  expect(state.information).toEqual([65])
  expect(state.target).toBe('old')
  expect(state.paths).toEqual([])
})

it.each(['OpenProcessToken', 'GetTokenInformation', 'CreatePrivateObjectSecurityEx', 'DestroyPrivateObjectSecurity'])('binds %s without admitting unverified security inheritance', (symbol) => {
  const api = createWindowsWriteApi(context)
  expect(() => api.security(2)).toThrow('Windows')
  expect(state.declarations.filter(value => value.startsWith('advapi32.dll:')).map(value => value.match(/__stdcall (\w+)/)?.[1]))
    .toEqual(['OpenProcessToken', 'GetTokenInformation', 'CreatePrivateObjectSecurityEx', 'DestroyPrivateObjectSecurity'])
  expect(state.declarations.some(value => value.includes(`${symbol}(`))).toBe(true)
  expect(state.target).toBe('old')
  expect(state.paths).toEqual([])
})

it('refuses a missing Native export before attempting replacement', () => {
  state.missing = 'NtSetInformationFile'
  expect(replace).toThrow('missing export')
  expect(state.information).toEqual([])
  expect(state.target).toBe('old')
  expect(state.paths).toEqual([])
})
