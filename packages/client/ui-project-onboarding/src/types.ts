/** Persisted workspace opening selections shared by the Host and Client. */

/** Product-owned opening text and its target directories; omitted overrides follow the current session. */
export interface OpeningPreset {
  name: string
  prompt: string
  directories: string[]
  model?: string
  permission?: string
}

/** Absence means remind and not yet selected; chosen records explicit confirmation. */
export interface ProjectSelection {
  /** Opening policy applied to matching seat projects after explicit confirmation. */
  mode: 'off' | 'remind' | 'auto'
  /** Whether the user explicitly confirmed this workspace choice. */
  chosen: boolean
}
