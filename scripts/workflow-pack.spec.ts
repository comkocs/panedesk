/** Distribution checks for the portable workflow pack. */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../templates/workflow-pack')

describe('workflow pack distribution', () => {
  it('ships 215 bilingual entries with stable English fields', () => {
    const entries = readFileSync(resolve(root, 'entries.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(entries).toHaveLength(215)
    for (const entry of entries) {
      expect(entry.id).toBe(entry['编号'])
      for (const field of ['module', 'layer', 'title', 'text', 'rationale', 'min_scale', 'max_scale', 'required_features', 'dependencies', 'restore_condition', 'source_count']) {
        expect(entry).toHaveProperty(field)
      }
    }
  })

  it('ships five English-named profiles and paired instructions', () => {
    expect(readdirSync(resolve(root, 'profiles')).sort()).toEqual([
      'large-research.toml', 'medium-software.toml', 'novel-writing.toml', 'short-video.toml', 'small-software.toml',
    ])
    for (const stem of ['getting-started', 'usage', 'entries']) {
      expect(readFileSync(resolve(root, `${stem}.md`), 'utf8')).toContain(`(${stem}.zh.md)`)
      expect(readFileSync(resolve(root, `${stem}.zh.md`), 'utf8')).toContain(`(${stem}.md)`)
    }
  })
})
