/**
 * The settings skill page groups discovered skills into built-in, user, and
 * project without a session.
 */
import { describe, expect, it } from 'vitest'
import type { SkillSummary } from '@panedesk/dsh-skill'
import { skillCatalogGroup } from '../src/catalog-groups.ts'

function summary(source: SkillSummary['source'], path: string): SkillSummary {
  return {
    name: path,
    description: 'desc',
    invocation: { modelInvocable: true, userInvocable: true },
    source,
    provider: 'filesystem',
    path,
  }
}

describe('skill catalog groups', () => {
  it('maps bundled to built-in, user roots to user, and project roots to project', () => {
    expect(skillCatalogGroup(summary('bundled', '/app/skills/a/SKILL.md'))).toBe('builtin')
    expect(skillCatalogGroup(summary('user-dsh', '/home/u/.panedesk/skills/b/SKILL.md'))).toBe('user')
    expect(skillCatalogGroup(summary('user-agents', '/home/u/.agents/skills/c/SKILL.md'))).toBe('user')
    expect(skillCatalogGroup(summary('project-dsh', '/work/.panedesk/skills/d/SKILL.md'))).toBe('project')
    expect(skillCatalogGroup(summary('project-agents', '/work/.agents/skills/e/SKILL.md'))).toBe('project')
  })
})
