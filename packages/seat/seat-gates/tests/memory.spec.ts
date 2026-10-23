import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { SeatName } from '@panedesk/dsh-seat'
import { canonicalWritePath, checkMemoryWrite, literalWriteTargets } from '../src/memory.ts'

const seatA = 'seat-a' as SeatName
const seatB = 'seat-b' as SeatName
const roots = [{ path: '/memory/a', seats: [seatA] }, { path: '/memory/b', seats: [seatB] }, { path: '/memory/shared', seats: [seatA, seatB] }]
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('memory ownership', () => {
  it('refuses another seat and free windows with real authorized-directory alternatives', () => {
    expect(checkMemoryWrite('/memory/b/note.md', seatA, roots)).toMatchObject({ code: 'memory-seat-mismatch', alternative: 'Use seat_write with an authorized memory directory: /memory/a, /memory/shared.' })
    expect(checkMemoryWrite('/memory/a/note.md', null, roots)).toMatchObject({ code: 'memory-seat-mismatch', alternative: 'Open the owning seat before writing its memory directory.' })
    expect(checkMemoryWrite('/memory/a/note.md', seatA, roots)).toBeNull()
    expect(checkMemoryWrite('/memory/shared/note.md', seatA, roots)).toBeNull()
    expect(checkMemoryWrite('/memory/another/note.md', null, roots)).toBeNull()
  })
  it('resolves a symlink through the nearest existing ancestor before checking a new file', async () => {
    const root = await mkdtemp(join(process.cwd(), 'packages/seat/seat-gates/tests/.memory-'))
    temporary.push(root)
    await mkdir(join(root, 'owned'))
    await symlink(join(root, 'owned'), join(root, 'alias'))
    expect(await canonicalWritePath('alias/new/note.md', root)).toBe(join(root, 'owned/new/note.md'))
  })
  it('recognizes literal writes but leaves variable and encoded scripts to audit', () => {
    expect(literalWriteTargets('printf text > /memory/b/note.md')).toEqual(['/memory/b/note.md'])
    expect(literalWriteTargets('cp source /memory/b/note.md')).toEqual(['/memory/b/note.md'])
    expect(literalWriteTargets('rm /memory/b/note.md')).toEqual(['/memory/b/note.md'])
    expect(literalWriteTargets('printf text > "$ROOT/note.md"')).toEqual([])
    expect(literalWriteTargets('python -c "$ENCODED"')).toEqual([])
  })
})
