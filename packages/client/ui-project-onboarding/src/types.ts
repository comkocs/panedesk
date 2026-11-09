/** Persisted workspace opening selections shared by the Host and Client. */

/** Product-owned opening text and its target directories; omitted overrides follow the current session. */
export interface OpeningPreset {
  /** Display name used by the opening-preset menu. */
  name: string
  /** Opening text inserted into the unsent session draft. */
  prompt: string
  /** Working directories offered by this preset. */
  directories: string[]
  /** Optional model selection overriding the current session choice. */
  model?: string
  /** Optional permission level overriding the current session choice. */
  permission?: string
}

/** Absence means remind and not yet selected; chosen records explicit confirmation. */
export interface ProjectSelection {
  /** Opening policy applied to matching seat projects after explicit confirmation. */
  mode: 'off' | 'remind' | 'auto'
  /** Whether the user explicitly confirmed this workspace choice. */
  chosen: boolean
}
