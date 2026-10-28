import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, posix, sep, win32 } from 'node:path'
import * as paths from '../src/paths.ts'
import { appendArtifact, appendUnique, finishArtifact, recoverSegments } from '../src/journal.ts'
import { digest } from '../src/index-store.ts'
import { callStart, event, options } from './fixtures.ts'

vi.mock('../src/paths.ts', async importOriginal => ({ ...await importOriginal<typeof paths>() }))
const { ledgerRelative } = await vi.importActual<typeof paths>('../src/paths.ts')
const roots: string[] = []

async function root() {
  const path = await mkdtemp(join(import.meta.dirname, '.relative-paths-'))
  roots.push(path)
  return path
}

function usePaths(pathApi: typeof posix) {
  vi.spyOn(paths, 'ledgerRelative').mockImplementation((root, file) =>
    ledgerRelative(root.split(sep).join(pathApi.sep), file.split(sep).join(pathApi.sep), pathApi))
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('portable ledger relative paths', () => {
  it('normalizes Windows drive and UNC paths to the persisted slash representation', () => {
    expect(ledgerRelative('C:\\ledger\\node', 'C:\\ledger\\node\\events\\day\\tail.jsonl', win32))
      .toBe('events/day/tail.jsonl')
    expect(ledgerRelative('\\\\server\\share\\node', '\\\\server\\share\\node\\events\\day\\tail.jsonl', win32))
      .toBe('events/day/tail.jsonl')
    expect(ledgerRelative('/ledger/node', '/ledger/node/events/day/tail.jsonl', posix))
      .toBe('events/day/tail.jsonl')
    expect(ledgerRelative('/ledger/node', '/ledger/node/events/literal\\name.jsonl', posix))
      .toBe('events/literal\\name.jsonl')
  })

  it.each(['partial-response', 'keepalive-request'] as const)(
    'closes and replays %s with Windows relative paths and unchanged durable references', async (kind) => {
      const path = await root()
      usePaths(win32)
      const input = { callId: callStart.callId, kind, seq: 0, content: '{ "text": "part" }' }
      const first = await appendArtifact(path, input, options)
      if (first.kind === 'conflict') throw new Error('Unexpected conflict')
      expect(first.kind).toBe('appended')
      expect(first.reference.path).toMatch(/^artifacts\/[^/]+\/[^/]+\/0\/[^/]+\.jsonl$/)
      expect(first.reference.path).not.toContain('\\')
      const fragment = await readFile(join(path, first.reference.path))
      expect(await finishArtifact(path, first.reference, options)).toEqual({ kind: 'finished', reference: first.reference })
      expect(await appendArtifact(path, input, options)).toEqual({ kind: 'existing', reference: first.reference })
      expect(await finishArtifact(path, first.reference, options)).toEqual({ kind: 'existing', reference: first.reference })
      usePaths(posix)
      expect(await appendArtifact(path, input, options)).toEqual({ kind: 'existing', reference: first.reference })
      expect(await finishArtifact(path, first.reference, options)).toEqual({ kind: 'existing', reference: first.reference })
      expect(await readFile(join(path, first.reference.path))).toEqual(fragment)
    },
  )

  it('keeps tail recovery identities equal across POSIX and Windows reads without duplicate alerts', async () => {
    const identities: string[] = []
    for (const pathApi of [posix, win32]) {
      const path = await root()
      const directory = join(path, 'events', '2000-01-01')
      await mkdir(directory, { recursive: true })
      const tail = join(directory, 'tail.jsonl')
      await writeFile(tail, '{')
      usePaths(pathApi)
      await appendUnique(path, event(), options)
      const scan = await recoverSegments(path, options.maxRecordBytes)
      const alerts = scan.events.filter(item => item.kind === 'alert')
      expect(alerts).toHaveLength(1)
      identities.push(alerts[0]!.eventId)
      expect(alerts[0]!.eventId).toBe(`recovery:${digest('events/2000-01-01/tail.jsonl')}`)
      usePaths(pathApi === posix ? win32 : posix)
      await appendUnique(path, event('run/start'), options)
      const reread = await recoverSegments(path, options.maxRecordBytes)
      expect(reread.events.filter(item => item.kind === 'alert')).toEqual(alerts)
      expect(reread.tails).toEqual([tail])
      expect(reread.complete).toBe(false)
      expect(await readFile(tail, 'utf8')).toBe('{')
    }
    expect(identities[0]).toBe(identities[1])
  })
})
