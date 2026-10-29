/** Windows-only real ACL checks and twenty-write timing; launch with pnpm exec tsx. */
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { WindowsPrivateFiles } from '../src/windows-private-files.ts'
import { inspectWindowsPrivatePath } from '@panedesk/node-addon-system/windows-private-files'

if (process.platform !== 'win32') throw new Error('This acceptance script requires Windows and its built native addon')
const scratch = await fs.mkdtemp(join(process.cwd(), '.windows-native-'))
try {
  const root = join(scratch, 'private')
  const files = new WindowsPrivateFiles(root)
  await files.prepare()
  await files.write('credential', 'original')
  const acl = inspectWindowsPrivatePath(join(root, 'credential'), root)
  assert.ok(typeof acl === 'object' && acl !== null && 'protected' in acl && acl.protected === true)
  assert.equal(await files.read('credential', 64), 'original')
  await fs.link(join(root, 'credential'), join(root, 'hardlink'))
  await assert.rejects(files.read('credential', 64), /links/)
  await fs.unlink(join(root, 'hardlink'))
  const junction = join(scratch, 'junction')
  await fs.symlink(root, junction, 'junction')
  await assert.rejects(new WindowsPrivateFiles(junction).prepare(), /type|reparse/)
  const unlock = await files.lock()
  await assert.rejects(files.lock(), { code: 'EEXIST' })
  await unlock()
  const milliseconds: number[] = []
  for (let index = 0; index < 20; index++) {
    const start = performance.now()
    await files.write('credential', `timing-${index}`)
    milliseconds.push(performance.now() - start)
    assert.equal(await files.read('credential', 64), `timing-${index}`)
  }
  milliseconds.sort((a, b) => a - b)
  const medianMs = (milliseconds[9]! + milliseconds[10]!) / 2
  const p95Ms = milliseconds[18]!
  process.stdout.write(`${JSON.stringify({ writes: 20, medianMs, p95Ms, targetMet: medianMs <= 3000 && p95Ms <= 5000 })}\n`)
  assert.ok(medianMs <= 3000 && p95Ms <= 5000, 'Twenty-write latency exceeded the acceptance target')
} finally { await fs.rm(scratch, { recursive: true, force: true }) }
