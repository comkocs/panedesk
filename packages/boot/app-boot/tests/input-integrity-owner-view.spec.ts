/** One owner-record review shares authenticated records across every descendant lookup. */
import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'

vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }))
vi.mock('node:crypto', async original => ({ ...await original<typeof import('node:crypto')>() }))

it('reads and hashes each durable owner record once while checking all descendant copies', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'owner-view-'))
  onTestFinished(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  fs.mkdirSync(workspace)
  for (let index = 0; index < 16; index++) fs.writeFileSync(join(workspace, `${index}.json`), String(index))
  const integrity = new ProtectedInputIntegrity(workspace, home)
  integrity.observe(workspace)
  await integrity.grantWrite()
  const directory = join(home, 'windows-workspace-write', 'protected-inputs')
  const record = join(directory, crypto.createHash('sha256').update(workspace).digest('hex') + '.json')
  const text = fs.readFileSync(record, 'utf8')
  const reads = vi.spyOn(fs, 'readFileSync')
  const original = crypto.createHash
  let hashes = 0
  vi.spyOn(crypto, 'createHash').mockImplementation((...args) => {
    const hash = original(...args)
    const update = hash.update.bind(hash)
    vi.spyOn(hash, 'update').mockImplementation((...values) => {
      if (values[0] === text) hashes++
      return update(...values)
    })
    return hash
  })
  ProtectedInputIntegrity.openOwnerRecords(workspace, home)
  expect.soft(reads.mock.calls.filter(([path]) => path === record)).toHaveLength(1)
  expect.soft(hashes).toBe(1)
})
