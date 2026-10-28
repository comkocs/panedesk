import { afterEach, expect, it } from 'vitest'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendUnique, JournalViewOwner, readJournal } from '../src/journal.ts'
import { event, options } from './fixtures.ts'

const roots: string[] = []
const execute = promisify(execFile)
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function oldWatermark(root: string): Promise<Buffer> {
  const reader = resolve(process.env.LEDGER_COMPAT_READER_ROOT ?? join(import.meta.dirname, '../../../..'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
  env.TSX_TSCONFIG_PATH = join(reader, 'tsconfig.json')
  const script = `
    import { pathToFileURL } from 'node:url';
    const [tree, root] = process.argv.slice(1);
    const { recoverSegments } = await import(pathToFileURL(tree + '/packages/session/session-ledger/src/journal.ts').href);
    const scan = await recoverSegments(root, 1048576);
    if (!scan.complete) throw new Error('Incomplete compatibility fixture');
    process.stdout.write(scan.watermark);
  `
  const result = await execute(process.execPath, ['--import', join(reader, 'node_modules/tsx/dist/esm/index.mjs'),
    '--input-type=module', '-e', script, reader, root], { cwd: reader, env, timeout: 30000 })
  return Buffer.from(result.stdout)
}

for (const [label, fixture] of [
  ['V0', process.env.LEDGER_COMPAT_V0_ROOT],
  ['V0b', process.env.LEDGER_COMPAT_V0B_ROOT],
  ['segmented', undefined],
] as const) {
  it.skipIf(label !== 'segmented' && fixture === undefined)(`keeps the ${label} incremental watermark byte-identical to the full-scan reader`, async () => {
    const root = await mkdtemp(join(import.meta.dirname, '.watermark-compat-'))
    roots.push(root)
    if (fixture !== undefined) await cp(fixture, root, { recursive: true })
    const viewOwner = new JournalViewOwner()
    const retained = { ...options, viewOwner }
    try {
      if (label === 'segmented') {
        await appendUnique(root, event(), retained)
        await appendUnique(root, event('call/end'), retained)
      }
      const compare = async () => {
        const scan = await readJournal(root, retained)
        expect(scan.complete).toBe(true)
        expect(scan.events.length).toBeGreaterThan(0)
        const bytes = Buffer.from(scan.watermark)
        expect(bytes).toHaveLength(64)
        expect(bytes).toEqual(await oldWatermark(root))
      }
      await compare()
      await compare()
      if (label === 'segmented') {
        await appendUnique(root, event('run/start'), options)
        await compare()
      }
    } finally { viewOwner.dispose() }
  }, 30000)
}
