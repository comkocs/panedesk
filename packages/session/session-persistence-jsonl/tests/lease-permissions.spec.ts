/** Session locks remain owner-controlled independently of the launching shell's umask. */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionId } from '@panedesk/dsh-session'
import { LEASE_FILENAME, SessionWriteLease } from '../src/lease.ts'

it('creates a session lock without group or other write permissions under a permissive umask', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-lock-permissions-'))
  const previous = process.umask(0o002)
  try {
    const lease = await SessionWriteLease.acquire(directory, SessionId('permissions'))
    try {
      if (process.platform !== 'win32') {
        expect((await stat(join(directory, LEASE_FILENAME))).mode & 0o022).toBe(0)
      }
    } finally { await lease.release() }
  } finally {
    process.umask(previous)
    await rm(directory, { recursive: true, force: true })
  }
})
