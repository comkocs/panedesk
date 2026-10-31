/**
 * What the Skills page reads. The host supplies the three directories; this
 * package never reads the filesystem itself.
 */

import type { WorkspaceId } from '@panedesk/dsh-api-workspace-controller/client'

/** One of the three skill directories. */
export type SkillPageGroup = 'builtin' | 'user' | 'project'

/** One skill row. */
export interface SkillPageEntry {
  /** Skill name. */
  readonly name: string
  /** Short description. */
  readonly description: string
  /** Directory the skill was discovered in. */
  readonly group: SkillPageGroup
  /** Absolute source path. */
  readonly path: string
}

/** Why a listing did not produce rows. */
export type SkillPageRefusal = 'unavailable' | 'disabled' | 'denied' | 'failed'

/** What one listing answered. */
export type SkillPageListing =
  | { readonly kind: 'listed'; readonly entries: readonly SkillPageEntry[]; readonly workspace: boolean }
  | { readonly kind: 'refused'; readonly reason: SkillPageRefusal; readonly message?: string }

/** Host reads the page is allowed to make. */
export interface SkillPageOperations {
  /**
   * List the three directories.
   * @param workspaceId - registered workspace selected on this page, or undefined for host skills.
   * @returns the rows, or why none could be listed.
   */
  list(workspaceId?: WorkspaceId): Promise<SkillPageListing>
  /**
   * Open one source file through the host's existing path opener.
   * @param path - absolute source path from a listed row.
   * @returns the refusal message, or undefined once the host accepted the path.
   */
  open(path: string): Promise<string | undefined>
}
