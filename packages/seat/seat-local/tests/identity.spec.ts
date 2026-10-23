import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SeatName } from '@panedesk/dsh-seat'
import { canonicalPath, checkMemoryWrite, containsPath } from '../src/identity.ts'
import { definition, seat } from './fixtures.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('memory identity', () => {
  it('rejects another seat and free writers while allowing own and shared memory', async () => {
    const root = await mkdtemp(join(process.cwd(), '.seat-identity-')); roots.push(root)
    const own = join(root, 'own'), other = join(root, 'other'), shared = join(root, 'shared')
    await Promise.all([own, other, shared].map(path => mkdir(path)))
    const definitions = [definition(root, { memoryDirectories: [own, shared] }),
      definition(root, { seat: 'seat-b' as SeatName, memoryDirectories: [other, shared] })]
    const refusal = await checkMemoryWrite(join(other, 'file'), seat, definitions)
    expect(refusal?.error.code).toBe('memory-seat-mismatch')
    expect(refusal?.error.alternative).toContain(own)
    expect((await checkMemoryWrite(join(shared, 'file'), null, definitions))?.error.code).toBe('memory-seat-mismatch')
    expect(await checkMemoryWrite(join(own, 'file'), seat, definitions)).toBeNull()
    expect(await checkMemoryWrite(join(shared, 'file'), seat, definitions)).toBeNull()
    expect(await checkMemoryWrite(join(root, 'unregistered'), null, definitions)).toBeNull()
    await symlink(other, join(root, 'alias'))
    expect(await canonicalPath(join(root, 'alias', 'new', 'file'))).toBe(join(other, 'new', 'file'))
    expect((await checkMemoryWrite(join(root, 'alias', 'new'), seat, definitions))?.error.code).toBe('memory-seat-mismatch')
  })

  it('uses path segments and explicit Windows case and volume rules', () => {
    expect(containsPath('/root/a', '/root/ab')).toBe(false)
    expect(containsPath('C:\\Root', 'c:\\root\\file', 'win32')).toBe(true)
    expect(containsPath('C:\\Root', 'D:\\Root\\file', 'win32')).toBe(false)
  })
})
