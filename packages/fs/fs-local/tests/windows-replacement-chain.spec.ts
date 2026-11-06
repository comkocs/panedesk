import { beforeEach, expect, it, vi } from 'vitest'
import { FsError } from '@panedesk/dsh-fs'
import { createWindowsWriteExtension } from '../src/win32-write-backend.ts'
import { createStageHandler } from '../src/win32-stage.ts'
import { captureReplacementMetadata } from '../src/win32-replacement-metadata.ts'
import type { ReplacementMetadataApi, BackupStream } from '../src/win32-replacement-metadata.ts'
import type { WindowsWriteApi } from '../src/win32-write-abi.ts'
import { metadata } from './fixtures/windows-directory-api.ts'

const paths = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: () => { paths.push('writeFile'); throw new Error('path write') },
    rename: () => { paths.push('rename'); throw new Error('path rename') } }
})
beforeEach(() => { paths.length = 0 })

const reasons = [
  ['security', 'Security descriptor equivalence is unknown / 无法判定安全描述符等价'],
  ['audit', 'Audit or integrity information cannot be preserved / 无法保留审核或完整性信息'],
  ['efs', 'EFS replacement is unsupported / 不支持覆盖 EFS 加密文件'],
  ['enterprise', 'Enterprise-protected replacement is unsupported / 不支持覆盖企业保护文件'],
  ['resource', 'Security resource attributes are unsupported / 不支持安全资源属性'],
  ['detection', 'Protection detection failed / 保护检测失败'],
  ['occupied', 'File is in use by another program; close it and retry / 文件被其他程序占用，请关闭后重试'],
  ['attributes', 'Unverified file attributes / 未核实的文件属性'],
  ['stream', 'Unknown backup stream / 未知备份流'],
] as const

function fixture(failure = '') {
  let target = 'old'
  let staged = ''
  let next = 10
  const live = new Set<number>()
  const calls: string[] = []
  const basic = Buffer.alloc(40)
  basic.writeBigInt64LE(123n); basic.writeUInt32LE(0x22, 32)
  const streams: BackupStream[] = [{ id: 4, attributes: 0, name: ':keep:$DATA', data: Buffer.from('kept') }]
  const meta: ReplacementMetadataApi = {
    basic(token) { const result = Buffer.from(basic); result.writeUInt32LE(token === 2 ? 2 : 32, 32)
      if (token !== 2) result.writeBigInt64LE(456n, 16)
      if (failure === 'efs') result.writeUInt32LE(0x4000, 32)
      if (failure === 'attributes') result.writeUInt32LE(0x100000, 32)
      return result },
    compression: () => 2,
    resourceAttributes: () => failure === 'resource',
    enterpriseProtected() { if (failure === 'detection') throw new Error('query failed'); return failure === 'enterprise' },
    streams(token) { return token === 2 ? failure === 'stream' ? [{ id: 99, attributes: 0, name: '', data: Buffer.alloc(0) }] : streams : [] },
    setBasic(_token, value) { calls.push(`basic:${value.readBigInt64LE(0)}:${value.readBigInt64LE(16)}:${value.readUInt32LE(32)}`) },
    setCompression() { calls.push('compression') },
    writeStream(_token, stream) { calls.push(`stream:${stream.name}:${stream.data.toString()}`) },
  }
  const api: WindowsWriteApi = {
    security() { throw new Error('unexpected new-file policy') },
    prepareReplacement() {
      calls.push('capture')
      if (failure === 'security' || failure === 'audit') {
        const reason = reasons.find(([key]) => key === failure)
        throw new FsError(reason?.[1] ?? 'missing reason', 'FS_IO_ERROR')
      }
      const prepare = captureReplacementMetadata(meta, 2)
      live.add(2)
      return { prepare(token) { calls.push('metadata'); prepare(token) }, close() { calls.push('old-close'); live.delete(2) } }
    },
    createDirectory() { const token = ++next; live.add(token); calls.push('private'); return { kind: 'opened', token, metadata: metadata('C:\\safe', true) } },
    createFile(parent, _name, descriptor) { expect(parent).toBe(1); expect(descriptor).toBeNull(); const token = ++next; live.add(token); calls.push('inherited'); return token },
    secureEmpty() { calls.push('secure') }, inspect: () => metadata('C:\\safe\\file'), read: () => Buffer.from(staged),
    write(_token, bytes) { expect(calls.includes('inherited')).toBe(true); expect(target).toBe('old'); calls.push('write'); staged += Buffer.from(bytes).toString(); return bytes.length },
    flush() { calls.push('flush'); expect(target).toBe('old') },
    link() { throw new Error('unexpected fallback link') },
    replace() { calls.push('replace'); expect(target).toBe('old'); expect(calls.includes('metadata')).toBe(true)
      if (failure === 'occupied') throw new FsError(reasons[6][1], 'FS_PERMISSION_DENIED')
      target = staged },
    disposition(token) { calls.push(`dispose:${token}`); if (token === 11 && target !== 'old') target = 'deleted' },
    openRemoval() { throw new Error('unexpected removal') }, close(token) { live.delete(token) },
  }
  const handler = createStageHandler(api)
  const extension = createWindowsWriteExtension({ parent: 1, entry: { kind: 'child', name: 'file' },
    async execute(request) {
      if (request.kind === 'root' || request.kind === 'open' || request.kind === 'inspect' || request.kind === 'read'
        || request.kind === 'enumerate' || request.kind === 'close' || request.kind === 'shutdown') throw new Error('unexpected request')
      return handler.execute(request)
    },
    async probe() { return metadata('C:\\safe\\file') },
    async openRead() { return { identity: metadata('C:\\safe\\file').identity,
      async read(buffer, offset, length, position) { const bytes = Buffer.from('old').subarray(position, position + length); buffer.set(bytes, offset); return bytes.length }, async close() {} } },
  })
  return { extension, handler, calls, live, target: () => target }
}

it('publishes replacement only after security and metadata, and never deletes the committed file', async () => {
  const f = fixture()
  try {
    await f.extension.write('new', 0o666, undefined, {})
    expect(f.target()).toBe('new')
    expect(f.calls).toEqual(['capture', 'inherited', 'write', 'flush', 'metadata', 'compression',
      'stream::keep:$DATA:kept', 'basic:123:456:34', 'replace', 'old-close'])
    expect(f.live.size).toBe(0)
    expect(paths).toEqual([])
  } finally { await f.handler.close() }
})

it.each(reasons)('refuses %s with bilingual reason, unchanged target and no path fallback', async (failure, reason) => {
  const f = fixture(failure)
  try {
    await expect(f.extension.write('new', 0o666, undefined, {})).rejects.toThrow(reason)
    expect(f.target()).toBe('old')
    expect(f.live.size).toBe(0)
    expect(paths).toEqual([])
  } finally { await f.handler.close() }
})

it('reads edit and diff content through the authorized opened handle', async () => {
  const f = fixture()
  const authorize = vi.fn()
  try {
    expect(await f.extension.readForEdit('file', undefined, authorize)).toEqual({ content: 'old', lineEndings: 'LF' })
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(await f.extension.readTextForDiff(3)).toBeNull()
    expect(paths).toEqual([])
  } finally { await f.handler.close() }
})
