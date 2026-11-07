import { mkdtemp, mkdir, open, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { writeFileAtomic } from '../src/fsio.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdir: vi.fn(actual.mkdir), open: vi.fn(actual.open), rename: vi.fn(actual.rename) }
})

it('reports the write step, path, permission denial or system failure in English and Chinese', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fs-write-errors-'))
  const destination = join(directory, 'target.txt')
  const stagingDir = join(directory, '.staging')
  const tempPath = join(stagingDir, 'target.tmp')
  const internals = { tempDirName: () => '.staging', tempName: () => 'target.tmp' }
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  try {
    for (const [code, reason] of [['EACCES', 'access denied'], ['EPERM', 'operation not permitted'], ['EIO', 'input/output error'], ['ENOSPC', 'no space left on device']]) {
      const cause = Object.assign(new Error(reason), { code })
      vi.mocked(mkdir).mockRejectedValueOnce(cause)
      const denied = code === 'EACCES' || code === 'EPERM'
      await expect.soft(writeFileAtomic(destination, 'text', undefined, undefined, internals)).rejects.toMatchObject({
        code: denied ? 'FS_PERMISSION_DENIED' : 'FS_IO_ERROR',
        message: `cannot create directory / 建目录 "${directory}": ${denied ? 'permission denied / 被拒（权限）' : `system call failed / 系统调用失败: ${reason}`}`,
        cause,
      })
    }
    const cause = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    for (const step of ['directory', 'file', 'write', 'rename', 'link']) {
      let operation: string
      let path: string
      switch (step) {
        case 'directory':
          vi.mocked(mkdir).mockImplementationOnce(actual.mkdir).mockRejectedValueOnce(cause)
          operation = 'create directory / 建目录'
          path = stagingDir
          break
        case 'file':
          vi.mocked(open).mockRejectedValueOnce(cause)
          operation = 'create file / 建文件'
          path = tempPath
          break
        case 'write':
          vi.mocked(open).mockImplementationOnce(async (...args) => {
            const handle = await actual.open(...args)
            vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(cause)
            return handle
          })
          operation = 'write / 写入'
          path = tempPath
          break
        default:
          if (step === 'rename') vi.mocked(rename).mockRejectedValueOnce(cause)
          operation = step === 'rename' ? 'rename / 改名' : 'create file / 建文件'
          path = destination
      }
      await expect.soft(writeFileAtomic(destination, 'text', undefined, undefined, {
        ...internals,
        ...(step === 'link' ? { linkFile: async () => { throw cause } } : {}),
      }, step === 'link' ? { displayPath: destination } : undefined)).rejects.toMatchObject({
        code: 'FS_IO_ERROR',
        message: `cannot ${operation} "${path}": system call failed / 系统调用失败: no space left on device`,
        cause,
      })
    }
  } finally {
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  }
})
