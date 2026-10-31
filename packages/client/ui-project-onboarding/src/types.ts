/** Persisted workspace opening selections shared by the Host and Client. */

/** Absence means remind and not yet selected; chosen records explicit confirmation. */
export interface ProjectSelection {
  mode: 'off' | 'remind' | 'auto'
  chosen: boolean
}
