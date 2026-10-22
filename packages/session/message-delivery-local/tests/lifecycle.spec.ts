import { mkdtemp, readFile, chmod, symlink, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { FileMailbox } from '../src/mailbox.ts'
import { publish, readValue, privateDirectory, object } from '../src/files.ts'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
async function storage() {
  const home = await mkdtemp(join(tmpdir(), 'mailbox-'))
  homes.push(home)
  const mailbox = new FileMailbox({ home, nodeId: 'node-a', maxRecordBytes: 65536, lockTimeoutMs: 5000, lockRetryMs: 1 })
  await mailbox.initialize()
  return { home, mailbox }
}

describe('file mailbox publication', () => {
  it('serializes concurrent sends and controls and replays an operation without allocating again', async () => {
    const { mailbox } = await storage()
    const records = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      mailbox.append('seat-a', `operation-${index}`, `digest-${index}`, { kind: index % 2 ? 'withdraw' : 'send' })))
    expect(records.map(record => record.sequence).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
    const repeated = await mailbox.append('seat-a', 'operation-0', 'digest-0', { ignored: true })
    expect(repeated).toEqual(records[0])
    await expect(mailbox.append('seat-a', 'operation-0', 'different', {})).rejects.toThrow('Conflicting mailbox operation')
    expect((await mailbox.snapshot('seat-a')).records).toHaveLength(20)
  })

  it('recovers a stale watermark and reports sequence holes without awaiting absent records', async () => {
    const { mailbox } = await storage()
    const root = await mailbox.target('seat-a')
    await publish(join(root, 'records', '0000000000000003.json'),
      { sequence: 3, operationId: 'operation-a', digest: 'digest-a', value: {} }, 65536)
    await publish(join(root, 'watermark.json'), { sequence: 1 }, 65536)
    await writeFile(join(root, 'records', '.pending-incomplete'), '{', { mode: 0o600 })
    expect(await mailbox.snapshot('seat-a')).toMatchObject({ high: 3, skipped: [[1, 2]] })
    expect((await mailbox.append('seat-a', 'operation-b', 'digest-b', {})).sequence).toBe(4)
  })

  it('rejects corrupted version, length and digest envelopes', async () => {
    const { mailbox } = await storage()
    const root = await mailbox.target('seat-a')
    const path = join(root, 'receipts', 'sample.json')
    for (const change of [{ version: 2 }, { length: 0 }, { digest: 'bad' }]) {
      await publish(path, { text: 'héllo' }, 65536)
      const envelope: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!object(envelope)) throw new Error('Expected an envelope object')
      await writeFile(path, JSON.stringify({ ...envelope, ...change }), { mode: 0o600 })
      await expect(readValue(path, 65536)).rejects.toThrow('checksum or version')
    }
    await expect(publish(path, { text: 'é'.repeat(100) }, 100)).rejects.toThrow('byte limit')
  })

  it.skipIf(process.platform === 'win32')('creates private files and refuses linked directories and files', async () => {
    const { home, mailbox } = await storage()
    const root = await mailbox.target('seat-a')
    const path = join(root, 'receipts', 'sample.json')
    await publish(path, {}, 65536)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await symlink(root, join(home, 'linked'))
    await expect(privateDirectory(home, join(home, 'linked'))).rejects.toThrow()
    await symlink(path, join(root, 'receipts', 'linked.json'))
    await expect(readValue(join(root, 'receipts', 'linked.json'), 65536)).rejects.toThrow()
    await chmod(path, 0o644)
    await expect(readValue(path, 65536)).rejects.toThrow('permissions')
  })
})
