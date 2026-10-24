/** Windows policy regressions run against mapped files and SID metadata on any server. */
import { afterEach, expect, test, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { WindowsPrivateFiles } from '../src/windows-private-files.ts'
import { inspectWindowsPrivatePath, replaceWindowsPrivatePath, secureWindowsPrivatePath } from '../src/windows-private-files-system.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
const root = 'C:\\private'
const sid = 'S-1-5-21-100-200-300-1001'
const rule = () => ({ sid, inherited: false, allow: true, rights: 2032127, propagation: 0 })
const metadata = () => ({ reparse: false, parents: true, sid, owner: sid, protected: true, rules: [rule()] })

async function fixture() {
  const directory = await fs.mkdtemp(join(process.cwd(), '.windows-private-test-'))
  roots.push(directory)
  const mapped = (path: string) => join(directory, ...path.slice(3).split('\\').filter(Boolean))
  const values = new Map<string, ReturnType<typeof metadata>>()
  const events: string[] = []
  const execute = vi.fn(async (script: string) => {
    const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1]
    if (!encoded) throw new Error('Expected encoded path')
    const path = Buffer.from(encoded, 'base64').toString('utf8')
    if (script.includes('Set-Acl')) {
      expect((await fs.stat(mapped(path))).isDirectory() || (await fs.stat(mapped(path))).size === 0).toBe(true)
      events.push(`secure:${win32.basename(path)}`)
      values.set(path, metadata())
      return ''
    }
    events.push(`inspect:${win32.basename(path)}`)
    return JSON.stringify(values.get(path) ?? metadata())
  })
  const filesystem = {
    lstat: vi.fn((path: string) => fs.lstat(mapped(path))),
    mkdir: vi.fn((path: string) => fs.mkdir(mapped(path))),
    rmdir: vi.fn((path: string) => fs.rmdir(mapped(path))),
    open: vi.fn((path: string, flags: string | number) => fs.open(mapped(path), flags)),
    unlink: vi.fn((path: string) => fs.unlink(mapped(path))),
  }
  const replace = vi.fn(async (source: string, target: string) => {
    events.push('replace')
    await fs.rename(mapped(source), mapped(target))
  })
  const delay = vi.fn(async (_milliseconds: number) => {})
  const files = new WindowsPrivateFiles(root, { execute, filesystem, replace, delay })
  return { files, execute, filesystem, replace, delay, values, mapped, events }
}

test('secures empty objects before writing and preserves owner-only replacement and locks', async () => {
  const f = await fixture()
  expect(await f.files.read('absent', 64)).toBeNull()
  await f.files.write('credential', 'first')
  await f.files.write('credential', 'second')
  expect(await f.files.read('credential', 64)).toBe('second')
  expect(f.events.findIndex(event => event.startsWith('secure:write-'))).toBeLessThan(f.events.indexOf('replace'))
  const release = await f.files.lock()
  await expect(f.files.lock()).rejects.toMatchObject({ code: 'EEXIST' })
  await release()
  await fs.writeFile(f.mapped(win32.join(root, 'owner.lock')), 'abandoned')
  await expect(f.files.lock()).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await fs.readFile(f.mapped(win32.join(root, 'owner.lock')), 'utf8')).toBe('abandoned')
  await f.files.remove('credential')
  expect(await f.files.read('credential', 64)).toBeNull()
})

test.each([
  ['entry count', { rules: [rule(), { ...rule(), sid: 'S-1-5-18' }] }],
  ['entry count', { rules: [] }],
  ['SID', { rules: [{ ...rule(), sid: 'S-1-5-32-544' }] }],
  ['inheritance', { protected: false }],
  ['inheritance', { rules: [{ ...rule(), inherited: true }] }],
  ['rights', { rules: [{ ...rule(), allow: false }] }],
  ['rights', { rules: [{ ...rule(), rights: 1 }] }],
  ['rights', { rules: [{ ...rule(), propagation: 2 }] }],
  ['owner', { owner: 'S-1-5-18' }],
  ['reparse', { reparse: true }],
  ['parent', { parents: false }],
])('rejects unsafe existing directory %s without changing its ACL', async (reason, patch) => {
  const f = await fixture()
  await f.files.prepare()
  f.values.set(root, { ...metadata(), ...patch })
  f.execute.mockClear()
  await expect(f.files.prepare()).rejects.toThrow(reason)
  expect(f.execute.mock.calls.every(([script]) => !script.includes('Set-Acl'))).toBe(true)
})

test('rechecks file ACLs and parent reparse points on every read, write and removal', async () => {
  const f = await fixture(), path = win32.join(root, 'credential')
  await f.files.write('credential', 'unchanged')
  f.values.set(path, { ...metadata(), rules: [rule(), { ...rule(), sid: 'S-1-1-0' }] })
  f.execute.mockClear()
  await expect(f.files.read('credential', 64)).rejects.toThrow('entry count')
  await expect(f.files.write('credential', 'replacement')).rejects.toThrow('entry count')
  await expect(f.files.remove('credential')).rejects.toThrow('entry count')
  expect(await fs.readFile(f.mapped(path), 'utf8')).toBe('unchanged')
  expect(f.execute.mock.calls.every(([script]) => !script.includes('Set-Acl'))).toBe(true)
  f.values.set('C:\\', { ...metadata(), reparse: true })
  await expect(f.files.prepare()).rejects.toThrow('reparse')
})

test.each(['EPERM', 'EBUSY'])('retries %s with bounded backoff and cleans failed temporary files', async (code) => {
  const f = await fixture()
  const error = Object.assign(new Error('sharing violation'), { code })
  f.replace.mockRejectedValueOnce(error).mockRejectedValueOnce(error)
  await f.files.write('credential', 'first')
  expect(f.delay.mock.calls).toEqual([[10], [20]])
  f.replace.mockRejectedValue(error)
  f.delay.mockClear()
  await expect(f.files.write('credential', 'second')).rejects.toThrow('sharing violation')
  expect(f.delay.mock.calls).toEqual([[10], [20], [40], [40]])
  expect(await fs.readdir(f.mapped(root))).toEqual(['credential'])
  expect(await f.files.read('credential', 64)).toBe('first')
})

test('rejects links, oversized files, invalid UTF-8, reserved names and nonlocal paths', async () => {
  const f = await fixture()
  await f.files.write('credential', 'content')
  await expect(f.files.read('credential', 2)).rejects.toThrow('limit')
  await fs.link(f.mapped(win32.join(root, 'credential')), f.mapped(win32.join(root, 'hard')))
  await expect(f.files.read('hard', 64)).rejects.toThrow('links')
  await fs.symlink(f.mapped(win32.join(root, 'credential')), f.mapped(win32.join(root, 'linked')))
  await expect(f.files.read('linked', 64)).rejects.toThrow('type')
  await fs.writeFile(f.mapped(win32.join(root, 'invalid')), Buffer.from([0xff]))
  await expect(f.files.read('invalid', 64)).rejects.toThrow()
  for (const name of ['../escape', 'stream:content', 'nul', 'COM1.txt', 'trailing.']) {
    await expect(f.files.read(name, 64)).rejects.toThrow('filename')
  }
  for (const path of ['relative', 'C:relative', '\\\\server\\share', 'C:\\a\\..\\b', 'C:\\stream:data', 'C:\\nul']) {
    expect(() => new WindowsPrivateFiles(path)).toThrow('path')
  }
})

test('cleans new empty directories and files after ACL or flush failure', async () => {
  const f = await fixture()
  const original = f.execute.getMockImplementation()!
  f.execute.mockImplementation(async (script) => {
    if (script.includes('Set-Acl')) throw new Error('ACL unavailable')
    return original(script)
  })
  await expect(f.files.prepare()).rejects.toThrow('ACL unavailable')
  await expect(fs.stat(f.mapped(root))).rejects.toMatchObject({ code: 'ENOENT' })
  f.execute.mockImplementation(original)
  await f.files.prepare()
  f.execute.mockImplementation(async (script) => {
    if (script.includes('Set-Acl')) throw new Error('ACL unavailable')
    return original(script)
  })
  await expect(f.files.write('credential', 'never published')).rejects.toThrow('ACL unavailable')
  await expect(f.files.lock()).rejects.toThrow('ACL unavailable')
  expect(await fs.readdir(f.mapped(root))).toEqual([])
  f.execute.mockImplementation(original)
  const open = f.filesystem.open.getMockImplementation()!
  f.filesystem.open.mockImplementation(async (path, flags) => {
    const handle = await open(path, flags)
    if (flags === 'wx') vi.spyOn(handle, 'sync').mockRejectedValue(new Error('flush unavailable'))
    return handle
  })
  await expect(f.files.write('credential', 'never published')).rejects.toThrow('flush unavailable')
  expect(await fs.readdir(f.mapped(root))).toEqual([])
})

test('maps Windows sharing failures and never retries unrelated replacement failures', async () => {
  const f = await fixture()
  const execute = f.execute.getMockImplementation()!
  let moves = 0
  const files = new WindowsPrivateFiles(root, { filesystem: f.filesystem, delay: f.delay,
    execute: async script => script.includes('MoveFileExW') ? (++moves < 3 ? '32' : '87') : execute(script) })
  await expect(files.write('credential', 'not published')).rejects.toMatchObject({ code: 'EIO' })
  expect(moves).toBe(3)
  expect(f.delay.mock.calls).toEqual([[10], [20]])
  expect(await fs.readdir(f.mapped(root))).toEqual([])
})

test('generates SID-only checks, full parent traversal and write-through same-volume moves', () => {
  const script = inspectWindowsPrivatePath('C:\\quoted\'path')
  expect(script).toContain('Security.Principal.SecurityIdentifier')
  expect(script).toContain('ReparsePoint')
  expect(script).toContain('GetParent')
  expect(script).not.toContain("quoted'path")
  expect(secureWindowsPrivatePath(root, true)).toContain('SetAccessRuleProtection($true, $false)')
  expect(replaceWindowsPrivatePath('C:\\source', 'C:\\target')).toContain(', 9)')
})
