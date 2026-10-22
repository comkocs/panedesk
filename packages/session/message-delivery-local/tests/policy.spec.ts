import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SubprocessIdentity } from '@panedesk/dsh-subprocess'
import { FileMailbox } from '../src/mailbox.ts'
import { NodeRegistry } from '../src/registry.ts'
import { validateAcl } from '../src/windows-permissions.ts'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
async function registry() {
  const home = await mkdtemp(join(tmpdir(), 'registry-'))
  homes.push(home)
  const mailbox = new FileMailbox({ home, nodeId: 'node-a', maxRecordBytes: 65536, lockTimeoutMs: 5000, lockRetryMs: 1 })
  await mailbox.initialize()
  let identity: SubprocessIdentity = { pid: process.pid, startIdentity: '100', bootIdentity: 'boot-a' }
  const owner = new NodeRegistry(mailbox, () => identity)
  return { owner, mailbox, change: (value: SubprocessIdentity) => { identity = value } }
}

describe('lease-backed runtime registrations', () => {
  it('publishes busy, idle and closing, then removes the released residency', async () => {
    const { owner } = await registry()
    const generation = await owner.register('seat-a', 'busy')
    await owner.assertOwner('seat-a', generation)
    expect(await owner.status('seat-a')).toBe('busy')
    await owner.update('seat-a', 'idle')
    expect(await owner.status('seat-a')).toBe('idle')
    await owner.update('seat-a', 'closing')
    expect(await owner.status('seat-a')).toBe('unavailable')
    await expect(owner.dispose()).rejects.toThrow('active Session leases')
    await owner.unregister('seat-a')
    expect(await owner.status('seat-a')).toBe('closed')
    await expect(owner.assertOwner('seat-a', generation)).rejects.toThrow('generation changed')
    await owner.dispose()
  })

  it('does not treat unknown process evidence as death and rejects PID reuse', async () => {
    const { owner, change } = await registry()
    await owner.register('seat-a', 'idle')
    change({ pid: process.pid })
    expect(await owner.status('seat-a')).toBe('unavailable')
    await expect(owner.register('seat-b', 'idle')).rejects.toThrow('identity is unavailable')
    change({ pid: process.pid, startIdentity: '101', bootIdentity: 'boot-a' })
    expect(await owner.status('seat-a')).toBe('closed')
    await owner.unregister('seat-a')
    await owner.dispose()
  })

  it('fences an old generation without deleting its successor on teardown', async () => {
    const { owner, mailbox } = await registry()
    const first = await owner.register('seat-a', 'idle')
    const successor = new NodeRegistry(mailbox, () => ({ pid: process.pid, startIdentity: '100', bootIdentity: 'boot-a' }))
    const next = await successor.register('seat-a', 'busy')
    await expect(owner.assertOwner('seat-a', first)).rejects.toThrow('generation changed')
    await owner.unregister('seat-a')
    await successor.assertOwner('seat-a', next)
    expect(await successor.status('seat-a')).toBe('busy')
    await owner.dispose()
    await successor.unregister('seat-a')
    await successor.dispose()
  })
})

describe('Windows inherited ACL admission', () => {
  const owner = 'S-1-5-21-100'
  it('permits only the current user, SYSTEM and Administrators read-write grants', () => {
    expect(() => { validateAcl(owner, [owner, 'S-1-5-18', 'S-1-5-32-544'].map(sid =>
      ({ sid, allow: true, rights: 0x1f01ff }))) }).not.toThrow()
  })
  it.each(['S-1-1-0', 'S-1-5-32-545', 'S-1-5-21-200'])('refuses foreign read-write principal %s', (sid) => {
    expect(() => { validateAcl(owner, [{ sid, allow: true, rights: 1 }]) }).toThrow('another principal')
  })
  it('permits deny entries and refuses unavailable ACL evidence', () => {
    expect(() => { validateAcl(owner, [{ sid: 'S-1-1-0', allow: false, rights: 1 }]) }).not.toThrow()
    expect(() => { validateAcl(owner, []) }).toThrow('unavailable')
    expect(() => { validateAcl('unknown', [{ sid: owner, allow: true, rights: 1 }]) }).toThrow('unavailable')
  })
})
