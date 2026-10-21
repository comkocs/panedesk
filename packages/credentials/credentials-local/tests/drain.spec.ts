import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialKey, credentialRef } from '@panedesk/dsh-credentials'
import { LocalCredentialProvider } from '../src/index.ts'

// The atomic write is the gated asynchronous hold point inside a queued
// write; gating it makes the dispose-versus-queued-write race fully
// deterministic. The lock helper passes through so the gated operation still
// runs inside its real acquire/release cycle.
const { writeGate, setGate } = vi.hoisted(() => {
  const writeGate = { current: Promise.resolve() }
  return {
    writeGate,
    setGate: (next: Promise<void>): void => {
      writeGate.current = next
    },
  }
})

vi.mock('@panedesk/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@panedesk/dsh-atomic-write')>()
  return {
    ...actual,
    writeFileAtomic: vi.fn(() => writeGate.current),
  }
})

const KEY = credentialRef('DSH_CRED_DRAIN_A')
const OTHER = credentialRef('DSH_CRED_DRAIN_B')
const RECORD = credentialKey('llm-drain', 'alpha')
const OTHER_RECORD = credentialKey('llm-drain', 'beta')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  setGate(Promise.resolve())
  while (cleanups.length > 0) await cleanups.pop()!()
})

describe('write-drain teardown', () => {
  it('lets the in-flight write land and fails the queued one after disposal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-drain-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const ctx = new Context()
    const fiber = ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await fiber
    const service = ctx.credentials

    let release!: () => void
    setGate(new Promise<void>((resolveGate) => {
      release = resolveGate
    }))
    const first = service.set(KEY, 'one')
    // Let the first task pass its liveness checks and park on the gate, so it
    // is genuinely in-flight when disposal begins.
    await new Promise(resolvePause => setTimeout(resolvePause, 5))
    // Attach the rejection handler up front: the queued write fails while the
    // drain is still awaited, before any later `await expect` could run.
    const secondRejects = expect(service.set(OTHER, 'two')).rejects.toThrow(/disposed before the queued/)
    const disposal = fiber.dispose()
    // Give the drain disposer its first turn (set closed) before opening the gate.
    await new Promise(resolvePause => setTimeout(resolvePause, 10))
    release()
    await disposal

    await expect(first).resolves.toBeUndefined()
    await secondRejects
    expect(await service.resolve(KEY)).toEqual({ value: 'one', source: 'file' })
    expect(await service.resolve(OTHER)).toBeUndefined()
  })

  it('fails a queued record write after disposal on the same terms', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-drain-record-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const ctx = new Context()
    const fiber = ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await fiber
    const service = ctx.credentials

    let release!: () => void
    setGate(new Promise<void>((resolveGate) => {
      release = resolveGate
    }))
    const first = service.modifyRecord(RECORD, () => Promise.resolve({ kind: 'grant', payload: { v: 1 } }))
    await new Promise(resolvePause => setTimeout(resolvePause, 5))
    const queuedModify = expect(service.modifyRecord(OTHER_RECORD, () => Promise.resolve({ kind: 'api-key' })))
      .rejects.toThrow(/disposed before the queued/)
    const queuedDelete = expect(service.deleteRecord(OTHER_RECORD)).rejects.toThrow(/disposed before the queued/)
    const disposal = fiber.dispose()
    await new Promise(resolvePause => setTimeout(resolvePause, 10))
    release()
    await disposal

    await expect(first).resolves.toEqual({ kind: 'grant', payload: { v: 1 } })
    await queuedModify
    await queuedDelete
    expect(await service.readRecord(OTHER_RECORD)).toBeUndefined()
  })
})
