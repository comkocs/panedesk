/** Preset documentation follows the generated bundle rows in both languages. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderPresetTable, updatePresetTable } from './gen-slim-base.ts'

const patch = `- insert:
    - id: agent
      name: '@panedesk/dsh-agent'
    - id: extra
      name: '@panedesk/dsh-extra/provider'
`
const begin = '<!-- BEGIN GENERATED preset-table -->'
const end = '<!-- END GENERATED preset-table -->'
const document = `# Presets\n\n${begin}\nold\n${end}\n\nKeep this paragraph.\n`

describe('preset documentation table', () => {
  it('renders full rows in source order and marks the slim subset', () => {
    const table = renderPresetTable(patch, ['agent'])
    expect(table).toContain('| `agent` | `@panedesk/dsh-agent` | yes | yes |')
    expect(table).toContain('| `extra` | `@panedesk/dsh-extra/provider` | no | yes |')
    expect(table.indexOf('`agent`')).toBeLessThan(table.indexOf('`extra`'))
    expect(table).toContain('slim: 1 rows; full: 2 rows')
  })

  it('rejects a slim row missing from the full bundle', () => {
    expect(() => renderPresetTable(patch, ['missing'])).toThrow('missing')
  })

  it('detects a one-row preset change without a documentation update', () => {
    const original = renderPresetTable(patch, ['agent'])
    const changed = renderPresetTable(patch, ['agent', 'extra'])
    const current = updatePresetTable(document, original)
    expect(updatePresetTable(current, changed)).not.toBe(current)
    const regenerated = updatePresetTable(current, changed)
    expect(updatePresetTable(regenerated, changed)).toBe(regenerated)
  })

  it('detects a changed full plugin name without a documentation update', () => {
    const original = renderPresetTable(patch, ['agent'])
    const changed = renderPresetTable(patch.replace('dsh-extra/provider', 'dsh-other/provider'), ['agent'])
    const current = updatePresetTable(document, original)
    expect(updatePresetTable(current, changed)).not.toBe(current)
  })

  it('preserves authored text outside the generated region', () => {
    expect(updatePresetTable(document, 'new')).toBe(document.replace('\nold\n', '\nnew\n'))
  })

  it.each([
    '# No markers\n',
    `${begin}\nunclosed\n`,
    `${document}\n${begin}\nsecond\n${end}\n`,
  ])('rejects missing or repeated generated regions: %s', (content) => {
    expect(() => updatePresetTable(content, 'new')).toThrow('preset-table')
  })

  it.each(['architecture.md', 'architecture.zh.md'])('keeps %s synchronized with the current preset rows', (file) => {
    const current = readFileSync(new URL(`../../docs/panedesk/${file}`, import.meta.url), 'utf8')
    expect(updatePresetTable(current, renderPresetTable())).toBe(current)
  })
})
