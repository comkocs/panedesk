import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReplacementMetadataApi } from '../src/win32-metadata-abi.ts'
import { captureReplacementMetadata } from '../src/win32-replacement-metadata.ts'
import type { WindowsNativeContext } from '../src/win32-handle-types.ts'
import { metadata } from './fixtures/windows-directory-api.ts'

const state = vi.hoisted(() => ({ tag: 0x20, basic: 0x20, fail: -1, queries: [] as number[], paths: [] as string[], target: 'old' }))
vi.mock('koffi', async (original) => {
  const actual = await original<typeof import('koffi')>()
  return { default: { ...actual.default, load: () => ({ func: (declaration: string) => {
    if (declaration.includes('GetFileInformationByHandleEx(')) return (_handle: object, information: number, buffer: Buffer) => {
      state.queries.push(information)
      if (state.fail === information) return 0
      buffer.writeUInt32LE(information === 9 ? state.tag : state.basic, information === 9 ? 0 : 32)
      return 1
    }
    if (/GetFileProtectionInfo|ReplaceFileW|MoveFile/.test(declaration)) return () => { state.paths.push(declaration); return 1 }
    if (declaration.includes('GetLastError(')) return () => 5
    return () => { throw new Error('Unexpected metadata mutation') }
  } }) } }
})
const context: WindowsNativeContext = {
  get: () => Buffer.alloc(8), inspect: () => metadata('C:\synthetic\target'),
  adopt() { throw new Error('Unexpected adoption') }, release() { throw new Error('Unexpected release') },
}
beforeEach(() => { state.tag = 0x20; state.basic = 0x20; state.fail = -1; state.queries = []; state.paths = []; state.target = 'old' })
afterEach(() => vi.restoreAllMocks())

it('accepts only successful unencrypted handle attribute queries', () => {
  expect(createReplacementMetadataApi(context).enterpriseProtected(1)).toBe(false)
  expect(state.queries).toEqual([9, 0])
  expect(state.paths).toEqual([])
})
it.each(['EFS', 'enterprise protection'])('refuses encrypted %s through the handle before mutation', () => {
  state.basic = 0x4020
  const api = createReplacementMetadataApi(context)
  expect(() => captureReplacementMetadata(api, 1)).toThrow('Encrypted / possibly enterprise-protected file / 已加密 / 可能受企业保护')
  expect(state.target).toBe('old')
  expect(state.paths).toEqual([])
})
it.each([9, 0])('refuses failed handle information class %i without fallback', (information) => {
  state.fail = information
  expect(() => createReplacementMetadataApi(context).enterpriseProtected(1)).toThrow('Protection detection failed / 保护检测失败')
  expect(state.target).toBe('old')
  expect(state.paths).toEqual([])
})
it.each(['tag', 'basic'] as const)('detects encryption in the %s observation', (field) => {
  state[field] = 0x4020
  expect(createReplacementMetadataApi(context).enterpriseProtected(1)).toBe(true)
  expect(state.queries).toEqual([9, 0])
  expect(state.target).toBe('old')
  expect(state.paths).toEqual([])
})
