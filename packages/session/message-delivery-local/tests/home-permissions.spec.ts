/** Product-home admission is separate from private mailbox storage. */
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileMailbox } from '../src/mailbox.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function mailbox(mode: number) {
  const home = await mkdtemp(join(process.env.PANEDESK_TEST_TEMP_ROOT ?? tmpdir(), 'mailbox-home-'))
  roots.push(home)
  await chmod(home, mode)
  return new FileMailbox({ home, nodeId: 'node-a', maxRecordBytes: 65536, lockTimeoutMs: 5000, lockRetryMs: 1 })
}

describe.skipIf(process.platform === 'win32')('product home permissions', () => {
  it('accepts a 0775 home without changing it and creates private mailbox descendants', async () => {
    const store = await mailbox(0o775)
    await store.initialize()
    await store.append('seat-a', 'operation-a', 'digest-a', {})
    expect((await stat(store.options.home)).mode & 0o777).toBe(0o775)
    expect((await stat(join(store.options.home, 'messages'))).mode & 0o777).toBe(0o700)
    const root = await store.target('seat-a')
    expect((await stat(join(root, 'records'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, 'records', '0000000000000001.json'))).mode & 0o777).toBe(0o600)
  })
  it('refuses a 0777 home without changing its permissions', async () => {
    const store = await mailbox(0o777)
    await expect(store.initialize()).rejects.toThrow('permissions')
    expect((await stat(store.options.home)).mode & 0o777).toBe(0o777)
  })
  it('refuses a home owned by a different user', async () => {
    const store = await mailbox(0o700)
    const owner = (await stat(store.options.home)).uid
    vi.spyOn(process, 'getuid').mockReturnValue(owner + 1)
    await expect(store.initialize()).rejects.toThrow('permissions')
  })
  it('refuses a preexisting 0750 messages directory without changing it', async () => {
    const store = await mailbox(0o775)
    const messages = join(store.options.home, 'messages')
    await mkdir(messages)
    await chmod(messages, 0o750)
    await expect(store.initialize()).rejects.toThrow('permissions')
    expect((await stat(messages)).mode & 0o777).toBe(0o750)
  })
})
