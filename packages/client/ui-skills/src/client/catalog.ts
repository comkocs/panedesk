/** Host-owned catalog and scan settings read without creating a session. */
import type { WorkspaceId } from '@panedesk/dsh-api-workspace-controller/client'
import type { SkillCatalogPageEntry, SkillCatalogPageValue, SkillCatalogSettings } from '@panedesk/dsh-api-session-controller/types'

/** Skill scope used for the effective catalog groups. */
export type SkillPageGroup = SkillCatalogPageEntry['group']
/** Effective skill row supplied by the host. */
export type SkillPageEntry = SkillCatalogPageEntry
/** One provider's editable scan controls. */
export type SkillPageSettings = SkillCatalogSettings
/** Why a listing could not complete. */
export type SkillPageRefusal = 'unavailable' | 'disabled' | 'denied' | 'failed'
/** Catalog response or a refusal the page can announce. */
export type SkillPageListing =
  | ({ readonly kind: 'listed'; readonly workspace: boolean } & SkillCatalogPageValue)
  | { readonly kind: 'refused'; readonly reason: SkillPageRefusal; readonly message?: string }

/** Operations bound to the existing host services. */
export interface SkillPageOperations {
  /**
   * Read effective skills, scan directories, and profile controls.
   * @param workspaceId - registered workspace, or undefined for global roots only.
   * @returns the catalog or an actionable refusal.
   */
  list(workspaceId?: WorkspaceId): Promise<SkillPageListing>
  /**
   * Open a source file or reveal it in the host file manager.
   * @param path - absolute host path returned by the catalog.
   * @param action - default opener or file-manager navigation.
   * @returns a refusal message, or undefined on success.
   */
  open(path: string, action?: 'open' | 'reveal'): Promise<string | undefined>
  /**
   * Save changed provider controls through the existing profile editor.
   * @param ns - provider entry returned by the catalog.
   * @param patch - changed scan fields.
   * @returns a failure message, or undefined after saving and reloading.
   */
  configure(ns: string, patch: Partial<Omit<SkillPageSettings['value'], 'customSkillDirs'>> & { customSkillDirs?: string[] }): Promise<string | undefined>
}
