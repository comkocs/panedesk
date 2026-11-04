/** Durable input records reject malformed snapshots without trusting current workspace bytes. */
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProtectedInputIntegrity } from '../src/input-integrity.ts'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'input-records-'))
  onTestFinished(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'project')
  const home = join(root, 'owner')
  const directory = join(home, 'windows-workspace-write', 'protected-inputs')
  mkdirSync(workspace)
  mkdirSync(directory, { recursive: true })
  const path = join(workspace, 'entry.js')
  writeFileSync(path, 'approved')
  const record = join(directory, createHash('sha256').update(workspace).digest('hex') + '.json')
  const snapshot = { digest: 'a'.repeat(64), kind: 'file', target: path, content: 'YXBwcm92ZWQ=' }
  const save = (value: unknown) => { writeFileSync(record, JSON.stringify(value)) }
  const saveSnapshot = (value: unknown) => { save({ version: 1, workspace, inputs: [{ path, snapshot: value }] }) }
  return { root, workspace, home, directory, path, record, snapshot, save, saveSnapshot }
}

it.each([
  null, [], {}, { digest: 1 }, { digest: 'invalid' },
  { digest: 'a'.repeat(64), kind: 'file', target: 2, content: null },
  { digest: 'a'.repeat(64), kind: 'file', target: null, content: 2 },
])('rejects malformed durable snapshot %j', (snapshot) => {
  const f = fixture()
  f.saveSnapshot(snapshot)
  expect(() => new ProtectedInputIntegrity(f.workspace, f.home)).toThrow('Invalid protected host input record')
})

it.each([
  ['kind', 'invalid', 'Invalid protected host input type'],
  ['treeDigest', 'invalid', 'Invalid protected input tree digest'],
  ['blob', 'invalid', 'Invalid protected input blob'],
  ['ancestors', {}, 'Invalid protected input ancestors'],
  ['ancestors', [null], 'Invalid protected input ancestor'],
  ['ancestors', [{ path: '/', mode: 1.2 }], 'Invalid protected input ancestor'],
  ['files', {}, 'Invalid protected input copies'],
  ['files', [null], 'Invalid protected input copy'],
  ['files', [{ path: '/outside' }], 'Invalid protected input copy'],
  ['files', [{ path: '/outside', content: '' }], 'Invalid protected input copy path'],
] as const)('rejects invalid %s record data %j', (key, value, message) => {
  const f = fixture()
  f.saveSnapshot({ ...f.snapshot, [key]: value })
  expect(() => new ProtectedInputIntegrity(f.workspace, f.home)).toThrow(message)
})

it.each([null, {}, { version: 2 }, { version: 1, workspace: '/', inputs: [] }])('rejects invalid workspace record %j', (record) => {
  const f = fixture()
  f.save(record)
  expect(() => new ProtectedInputIntegrity(f.workspace, f.home)).toThrow('Invalid protected workspace record')
})

it.each([null, {}, { path: '/outside', snapshot: {} }])('rejects invalid input entry %j', (entry) => {
  const f = fixture()
  f.save({ version: 1, workspace: f.workspace, inputs: [entry] })
  expect(() => new ProtectedInputIntegrity(f.workspace, f.home)).toThrow('Invalid protected input path')
})

it('reads inline historical copies and refuses missing or nonconfiguration copies', () => {
  const f = fixture()
  f.saveSnapshot({ ...f.snapshot, kind: 'directory', content: null, files: [{ path: f.path, content: 'YXBwcm92ZWQ=' }] })
  const reader = new ProtectedInputIntegrity(f.workspace, f.home)
  expect(() => reader.readTrusted(f.path)).toThrow('not a configuration file')
  f.saveSnapshot({ ...f.snapshot, kind: 'directory', content: null })
  const absent = new ProtectedInputIntegrity(f.workspace, f.home)
  expect(() => absent.readTrusted(join(f.path, 'child'))).toThrow('has no approved copy')
  expect(() => absent.readTrusted(join(f.workspace, 'unregistered'))).toThrow('has no approved copy')
  f.save({ version: 1, workspace: f.workspace, inputs: [{ path: f.workspace,
    snapshot: { ...f.snapshot, kind: 'directory', target: f.workspace, content: null, files: [{ path: f.path, content: 'YXBwcm92ZWQ=' }] } }] })
  const inline = new ProtectedInputIntegrity(f.workspace, f.home)
  expect(inline.readTrusted(f.path)?.toString()).toBe('approved')
})

it('rejects a corrupt content-addressed copy', async () => {
  const f = fixture()
  const integrity = new ProtectedInputIntegrity(f.workspace, f.home)
  integrity.observe(f.path)
  await integrity.grantWrite()
  const blob = createHash('sha256').update('approved').digest('hex')
  writeFileSync(join(f.directory, 'blobs', blob), 'corrupted')
  expect(() => integrity.readTrusted(f.path)).toThrow('Protected input copy changed')
})

it.each(['grant', 'verify'] as const)('rolls back approved candidates when %s persistence fails', async (operation) => {
  const f = fixture()
  const integrity = new ProtectedInputIntegrity(f.workspace, f.home)
  integrity.observe(f.path)
  if (operation === 'verify') {
    await integrity.grantWrite()
    writeFileSync(f.path, 'replacement')
  }
  const original = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
    if (args[1] === f.record) throw new Error('record publication failed')
    original(...args)
  })
  if (operation === 'grant') {
    await expect(integrity.grantWrite()).rejects.toThrow('record publication failed')
    expect(integrity.covers(f.path)).toBe(false)
  } else {
    await expect(integrity.verify({ blocked() {}, confirm: async () => true })).rejects.toThrow('record publication failed')
    expect(integrity.readTrusted(f.path)?.toString()).toBe('approved')
  }
})

it('refuses overlapping records with conflicting trusted copies', async () => {
  const f = fixture()
  const child = join(f.workspace, 'child')
  mkdirSync(child)
  const path = join(child, 'entry.js')
  writeFileSync(path, 'first')
  const parent = new ProtectedInputIntegrity(f.workspace, f.home)
  parent.observe(path)
  await parent.grantWrite()
  writeFileSync(path, 'second')
  const nested = new ProtectedInputIntegrity(child, f.home)
  nested.observe(path)
  await nested.grantWrite()
  expect(() => ProtectedInputIntegrity.openOwnerRecords(f.workspace, f.home)).toThrow('Conflicting protected host input records')
})

it('refuses a durable record stored under the wrong name', async () => {
  const f = fixture()
  const integrity = new ProtectedInputIntegrity(f.workspace, f.home)
  integrity.observe(f.path)
  await integrity.grantWrite()
  writeFileSync(join(f.directory, 'wrong.json'), readFileSync(f.record))
  expect(() => ProtectedInputIntegrity.openOwnerRecords(f.workspace, f.home)).toThrow('Invalid protected workspace record location')
})
