import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { buildCheckpoint, selectSection } from '../src/checkpoint.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function source() {
  const root = await mkdtemp(join(process.cwd(), 'packages/seat/seat-gates/tests/.checkpoint-'))
  roots.push(root)
  const path = join(root, 'rules.md')
  await writeFile(path, '# Rules\nKeep complete data.\n# Other\nOmit this section.\n')
  return { path, section: 'Rules', maxBytes: 4096, required: true }
}

describe('checkpoint data contribution', () => {
  it('appends complete quoted data after the summary and validates its frozen evidence', async () => {
    const file = await source()
    const result = await buildCheckpoint([file], 3, 4096, 4096, 512, text => text.length)
    const combined = `Summary${result.text}\nLedger inventory`
    expect(combined.indexOf('Summary')).toBeLessThan(combined.indexOf('Seat checkpoint data'))
    expect(combined.indexOf('Seat checkpoint data')).toBeLessThan(combined.indexOf('Ledger inventory'))
    expect(result.text).toContain('# Rules\\nKeep complete data.')
    expect(result.text).not.toContain('Omit this section')
    expect(result.evidence[0]).toMatchObject({ path: file.path, revision: 3 })
    expect(await result.validate()).toBe(true)
    await writeFile(file.path, '# Rules\nChanged data.\n')
    expect(await result.validate()).toBe(false)
  })
  it('rejects missing required sections and budget exhaustion without truncation', async () => {
    const file = await source()
    await expect(buildCheckpoint([{ ...file, section: 'Missing' }], 1, 4096, 4096, 512, text => text.length)).rejects.toThrow('missing')
    await expect(buildCheckpoint([file], 1, 4096, 512, 512, text => text.length)).rejects.toThrow('budget')
    await expect(buildCheckpoint([file], 1, 1, 4096, 512, text => text.length)).rejects.toThrow('budget')
  })
  it('reports optional omissions and refuses ambiguous heading selection', async () => {
    const file = await source()
    const result = await buildCheckpoint([{ ...file, required: false, section: 'Missing' }], 1, 4096, 4096, 0, text => text.length)
    expect(result.omitted).toEqual([file.path])
    expect(result.text).toContain('omitted')
    expect(selectSection('# Rules\na\n# Rules\nb\n', 'Rules')).toBeNull()
  })
})
