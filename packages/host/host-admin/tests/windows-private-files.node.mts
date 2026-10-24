/** Node-only regression for combined Windows metadata checks; no listener or PowerShell required. */
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join, resolve, win32 } from 'node:path'
import { WindowsPrivateFiles } from '../src/windows-private-files.ts'
import { inspectWindowsPrivatePath } from '../src/windows-private-files-system.ts'

for (const key of Object.keys(process.env)) if (/TICKET|DESK|TOKEN/i.test(key)) delete process.env[key]
assert.ok(process.argv[2], 'An existing scratch directory is required')
const scratch = await fs.mkdtemp(join(resolve(process.argv[2]!), 'a0j2-node-'))
const root = 'C:\\private', file = win32.join(root, 'credential')
const sid = 'S-1-5-21-100-200-300-1001'
const metadata = () => ({ reparse: false, parents: true, sid, owner: sid, protected: true,
  rules: [{ sid, inherited: false, allow: true, rights: 2032127, propagation: 0 }] })
const values = new Map<string, ReturnType<typeof metadata>>()
const mapped = (path: string) => join(scratch, ...path.slice(3).split('\\').filter(Boolean))
let calls = 0, passed = 0, closed = 0
let output: string | undefined
let swap = false
const execute = async (script: string) => {
  calls++
  const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1]
  assert.ok(encoded)
  const path = Buffer.from(encoded, 'base64').toString('utf8')
  if (script.includes('Set-Acl')) {
    const stat = await fs.stat(mapped(path))
    assert.ok(stat.isDirectory() || stat.size === 0)
    values.set(path, metadata())
    return ''
  }
  if (output !== undefined) return output
  if (swap) {
    await fs.rename(mapped(file), mapped(win32.join(root, 'old')))
    await fs.writeFile(mapped(file), 'replacement')
  }
  return JSON.stringify({ ...(values.get(path) ?? metadata()),
    ...(script.includes('$result.directory') ? { directory: values.get(root) ?? metadata() } : {}) })
}
const files = new WindowsPrivateFiles(root, { execute,
  filesystem: {
    lstat: path => fs.lstat(mapped(path)), mkdir: path => fs.mkdir(mapped(path)),
    rmdir: path => fs.rmdir(mapped(path)), unlink: path => fs.unlink(mapped(path)),
    open: async (path, flags) => {
      const handle = await fs.open(mapped(path), flags)
      const close = handle.close.bind(handle)
      handle.close = async () => { closed++; await close() }
      return handle
    },
  }, replace: (source, target) => fs.rename(mapped(source), mapped(target)),
})
try {
  await files.write('credential', 'content')
  calls = 0
  assert.equal(await files.read('credential', 64), 'content')
  assert.equal(calls, 1); passed++
  values.set(root, { ...metadata(), owner: 'S-1-5-18' })
  await assert.rejects(files.read('credential', 64), /owner/); passed++
  await assert.rejects(files.read('absent', 64), /owner/); passed++
  values.set(root, metadata())
  values.set(file, { ...metadata(), rules: [...metadata().rules, { ...metadata().rules[0]!, sid: 'S-1-1-0' }] })
  await assert.rejects(files.read('credential', 64), /entry count/)
  await assert.rejects(files.write('credential', 'never'), /entry count/)
  await assert.rejects(files.remove('credential'), /entry count/)
  assert.equal(await fs.readFile(mapped(file), 'utf8'), 'content'); passed++
  values.set(file, metadata())
  for (const invalid of ['{}', '{', JSON.stringify(metadata()), JSON.stringify({ reparse: true })]) {
    output = invalid
    const before = closed
    await assert.rejects(files.read('credential', 64))
    assert.equal(closed, before + 1)
  }
  passed++; output = undefined
  swap = true
  await assert.rejects(files.read('credential', 64), /identity/); passed++
  swap = false
  const release = await files.lock()
  await assert.rejects(files.lock(), { code: 'EEXIST' })
  await release(); passed++
  const script = inspectWindowsPrivatePath(file, root)
  for (const text of ['GetParent', 'ReparsePoint', 'GetOwner', 'SecurityIdentifier', '$result.directory']) {
    assert.ok(script.includes(text))
  }
  passed++
  console.log(JSON.stringify({ passed, failed: 0 }))
} catch (error) {
  console.log(JSON.stringify({ passed, failed: 1, category: error instanceof Error ? error.name : 'Unknown' }))
  process.exitCode = 1
} finally {
  await fs.rm(scratch, { recursive: true, force: true })
}
