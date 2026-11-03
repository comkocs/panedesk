/** Offline cleanup rejects sandbox tokens before changing owner-directory labels. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import koffi from 'koffi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupOwnerReadProtection } from '../src/owner-cleanup.ts'
import type { Win32Bindings } from '../src/ffi.ts'

const state = vi.hoisted(() => ({ restricted: 0, level: 'S-1-16-8192', cleanup: vi.fn(), close: vi.fn(() => 1) }))
vi.mock('../src/acl.ts', () => ({ setOwnerReadProtection: state.cleanup }))
vi.mock('../src/ace-diagnostic.ts', () => ({ sidText: () => state.level }))
vi.mock('../src/token.ts', () => ({ openCurrentProcessToken: () => 1n, makeWellKnownSid: () => 2n }))
vi.mock('../src/ffi.ts', async (original) => {
  const actual = await original<typeof import('../src/ffi.ts')>()
  const getTokenInformation: Win32Bindings['getTokenInformation'] = (_token, information, buffer, _length, needed) => {
    koffi.encode(needed, 'uint32', 16)
    if (buffer === null) return 0
    if (information === 11) buffer.writeUInt32LE(state.restricted)
    else buffer.writeBigUInt64LE(3n)
    return 1
  }
  return { ...actual, freeBytes: vi.fn(), win32: () => Promise.resolve({ getTokenInformation, closeHandle: state.close }) }
})

const directories: string[] = []
afterEach(() => {
  directories.splice(0).forEach((path) => { rmSync(path, { recursive: true, force: true }) })
  state.restricted = 0
  state.level = 'S-1-16-8192'
  vi.clearAllMocks()
})
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'owner-cleanup-'))
  directories.push(path)
  return path
}

describe('offline owner label cleanup', () => {
  it.each(['S-1-16-4096', 'S-1-16-0', 'S-1-5-8192'])('rejects integrity %s before changing labels', async (level) => {
    state.level = level
    await expect(cleanupOwnerReadProtection(directory())).rejects.toThrow('unrestricted Medium-or-higher')
    expect(state.cleanup).not.toHaveBeenCalled()
    expect(state.close).toHaveBeenCalledWith(1n)
  })
  it('rejects a restricted Medium process', async () => {
    state.restricted = 1
    await expect(cleanupOwnerReadProtection(directory())).rejects.toThrow('unrestricted Medium-or-higher')
    expect(state.cleanup).not.toHaveBeenCalled()
  })
  it('runs verified removal for an unrestricted owner and propagates interrupted cleanup', async () => {
    const path = directory()
    await cleanupOwnerReadProtection(path)
    expect(state.cleanup).toHaveBeenCalledWith(expect.objectContaining({ closeHandle: state.close }), path, 2n, false)
    state.cleanup.mockImplementationOnce(() => { throw new Error('interrupted') })
    await expect(cleanupOwnerReadProtection(path)).rejects.toThrow('interrupted')
    expect(state.close).toHaveBeenCalledTimes(2)
  })
})
