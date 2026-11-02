/** GitHub issue templates expose bilingual bug, feature, and question entry points. */
import { readFileSync, readdirSync } from 'node:fs'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const directory = new URL('../../.github/ISSUE_TEMPLATE/', import.meta.url)

describe('public issue templates', () => {
  it('offers exactly bug, feature, and question Markdown templates', () => {
    expect(readdirSync(directory).filter(file => file.endsWith('.md')).sort()).toEqual([
      'bug.md', 'feature.md', 'question.md',
    ])
  })

  it('disables blank issues without adding external contact links', () => {
    expect(load(readFileSync(new URL('config.yml', directory), 'utf8'))).toEqual({ blank_issues_enabled: false })
  })

  it.each(['bug', 'feature', 'question'])('gives %s English guidance and Chinese counterparts', (kind) => {
    const text = readFileSync(new URL(`${kind}.md`, directory), 'utf8')
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)
    expect(frontmatter).not.toBeNull()
    const metadata = load(frontmatter![1]!) as { name: string; about: string }
    expect(metadata.name.toLowerCase()).toContain(kind)
    expect(metadata.about).toMatch(/[A-Za-z]/)
    const sections = text.slice(frontmatter![0].length).split(/^## /m).slice(1)
    expect(sections.length).toBeGreaterThanOrEqual(2)
    for (const section of sections) {
      expect(section).toMatch(/<!-- [A-Za-z]/)
      expect(section).toMatch(/[一-鿿]/)
    }
    expect(text).toContain('Do not include API keys')
  })
})
