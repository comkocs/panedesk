/**
 * Group a discovered skill into the three directories the settings page lists.
 * Project roots stay project-scoped, user roots stay user-scoped, and the
 * bundled root is the built-in directory. Anything else is not one of the three.
 */
import type { SkillSummary } from '@panedesk/dsh-skill'

/** The three directories a settings page is allowed to show. */
export type SkillCatalogGroup = 'builtin' | 'user' | 'project'

/**
 * Classify one summary.
 * @param skill - a discovery summary.
 * @returns its directory, or `undefined` when it belongs to none of the three.
 */
export function skillCatalogGroup(skill: SkillSummary): SkillCatalogGroup | undefined {
  switch (skill.source) {
    case 'bundled':
      return 'builtin'
    case 'user-dsh':
    case 'user-agents':
    case 'user-claude':
      return 'user'
    case 'project-dsh':
    case 'project-agents':
    case 'project-claude':
      return 'project'
    default:
      return undefined
  }
}
