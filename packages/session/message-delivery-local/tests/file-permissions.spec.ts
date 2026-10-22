import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OperationId } from '@panedesk/dsh-message-delivery'
import { publish, publishedFiles, quarantineFile, readValue } from '../src/files.ts'
import { ReceiptStore } from '../src/receipts.ts'
import { ownerFixture } from './fixtures/owner.ts'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, open: vi.fn(actual.open), mkdir: vi.fn(actual.mkdir) }
})
afterEach(() => { vi.restoreAllMocks() })

const actual = await vi.importActual<typeof fs>('node:fs/promises')

describe.skipIf(process.platform === 'win32')('private mailbox file publication', () => {
  it.each([0o002, 0o022])('creates sends, controls, receipts and quarantine privately with umask %i', async (mask) => {
    const previous = process.umask(mask)
    const opened: string[] = []
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode)
      if (typeof flags === 'number' && (flags & constants.O_CREAT) !== 0) {
        expect(mode).toBe(0o600)
        const stat = await handle.stat()
        expect(stat.mode & 0o777).toBe(0o600)
        expect(stat.uid).toBe(process.getuid?.())
        opened.push(String(path))
      }
      return handle
    })
    const directories: string[] = []
    vi.mocked(fs.mkdir).mockImplementation(async (path, options) => {
      const result = await actual.mkdir(path, options)
      const stat = await fs.lstat(path)
      expect(stat.mode & 0o777).toBe(0o700)
      expect(stat.isSymbolicLink()).toBe(false)
      directories.push(String(path))
      return result
    })
    let f: Awaited<ReturnType<typeof ownerFixture>> | undefined
    try {
      f = await ownerFixture()
      await f.send()
      await f.control({ kind: 'withdraw', operationId: 'withdraw-a' as OperationId, expectedRevision: 0 })
      await f.arbitrator.drain()
      const receipt = f.receipts.at(-1)!
      await new ReceiptStore(f.mailbox).publish(receipt)
      const root = await f.mailbox.target(f.id)
      const name = (await publishedFiles(join(root, 'records')))[0]!
      await quarantineFile(f.home, join(root, 'records', name), join(root, 'quarantine', name))
      const verify = async (directory: string): Promise<void> => {
        for (const name of await fs.readdir(directory)) {
          const path = join(directory, name)
          const stat = await fs.lstat(path)
          expect(stat.isSymbolicLink()).toBe(false)
          expect(stat.uid).toBe(process.getuid?.())
          expect(stat.mode & 0o777).toBe(stat.isDirectory() ? 0o700 : 0o600)
          if (stat.isDirectory()) await verify(path)
        }
      }
      await verify(join(f.home, 'messages'))
      for (const kind of ['records', 'decisions', 'receipts']) {
        expect(opened.some(path => path.includes(`/${kind}/.pending-`))).toBe(true)
      }
      expect(opened.some(path => path.endsWith('publish.lock'))).toBe(true)
      expect(directories.some(path => path.endsWith('/quarantine'))).toBe(true)
    } finally {
      try { await f?.dispose() } finally { process.umask(previous) }
    }
  })

  it('reopens a private decision replaced while a control drains without timing sleeps', async () => {
    const f = await ownerFixture()
    const reached = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let reading: ReturnType<typeof f.status> | undefined
    try {
      await f.send()
      await f.arbitrator.drain()
      const root = await f.mailbox.target(f.id)
      const path = join(root, 'decisions', `${f.message.messageId}.json`)
      let paused = false
      vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
        const handle = await actual.open(name, flags, mode)
        if (String(name) === path && !paused) {
          paused = true
          reached.resolve(undefined)
          await release.promise
          expect((await handle.stat()).nlink).toBe(0)
        }
        return handle
      })
      reading = f.status()
      void reading.catch((error: unknown) => { reached.reject(error) })
      await reached.promise
      await f.control({ kind: 'withdraw', operationId: 'withdraw-a' as OperationId, expectedRevision: 0 })
      await f.arbitrator.drain()
      release.resolve(undefined)
      expect((await reading).status.state).toBe('withdrawn')
      await expect(f.arbitrator.drain()).resolves.toBeUndefined()
      expect(await f.result('withdraw-a')).toMatchObject({ kind: 'applied' })
    } finally {
      release.resolve(undefined)
      try { await reading } finally { await f.dispose() }
    }
  })

  it.each([
    ['permissions', 'Mailbox file permissions are not private'],
    ['hardlink', 'Mailbox file has more than one hard link'],
    ['symlink', 'Mailbox file was replaced while open and could not be reopened'],
    ['owner', 'Mailbox file is not owned by the current user'],
  ] as const)('rejects a replacement with invalid %s', async (kind, message) => {
    const f = await ownerFixture()
    try {
      const root = await f.mailbox.target(f.id)
      const path = join(root, 'decisions', 'seat-a.json')
      await publish(path, { revision: 0 }, 65536)
      let replaced = false
      vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
        const handle = await actual.open(name, flags, mode)
        if (String(name) === path && !replaced) {
          replaced = true
          await publish(path, { revision: 1 }, 65536)
          if (kind === 'permissions') await fs.chmod(path, 0o644)
          if (kind === 'hardlink') await fs.link(path, join(root, 'decisions', 'seat-b.json'))
          if (kind === 'symlink') {
            await fs.rename(path, join(root, 'decisions', 'seat-b.json'))
            await fs.symlink('seat-b.json', path)
          }
        } else if (String(name) === path && kind === 'owner') {
          const stat = await handle.stat()
          stat.uid++
          vi.spyOn(handle, 'stat').mockResolvedValue(stat)
        }
        return handle
      })
      await expect(readValue(path, 65536)).rejects.toThrow(message)
    } finally { await f.dispose() }
  })

  it.each([
    ['permissions', 'Mailbox file permissions are not private'],
    ['hardlink', 'Mailbox file has more than one hard link'],
    ['owner', 'Mailbox file is not owned by the current user'],
  ] as const)('names an open mailbox file rejected for %s', async (kind, message) => {
    const f = await ownerFixture()
    try {
      const root = await f.mailbox.target(f.id)
      const path = join(root, 'decisions', 'seat-a.json')
      await publish(path, { revision: 0 }, 65536)
      if (kind === 'permissions') await fs.chmod(path, 0o644)
      if (kind === 'hardlink') await fs.link(path, join(root, 'decisions', 'seat-b.json'))
      if (kind === 'owner') {
        vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
          const handle = await actual.open(name, flags, mode)
          if (String(name) === path) {
            const stat = await handle.stat()
            stat.uid++
            vi.spyOn(handle, 'stat').mockResolvedValue(stat)
          }
          return handle
        })
      }
      await expect(readValue(path, 65536)).rejects.toThrow(message)
    } finally { await f.dispose() }
  })

  it('names a directory opened as a mailbox entry', async () => {
    const f = await ownerFixture()
    try {
      const root = await f.mailbox.target(f.id)
      await expect(readValue(join(root, 'decisions'), 65536)).rejects.toThrow('Mailbox entry is not a regular file')
    } finally { await f.dispose() }
  })
})
