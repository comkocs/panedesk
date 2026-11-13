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

/** Localized editable delegation guidance, selected by the product language. */
export type DelegationText = {
  /** Chinese text. */
  zh: string
  /** English text. */
  en: string
}

/** One task tier's advisory selection; empty identifiers let the agent choose. */
export type SubagentTier = {
  /** When a task belongs to this tier, in each product language. */
  criteria: DelegationText
  /** LLM provider id of the suggested subagent model; empty lets the agent choose. */
  provider: string
  /** Suggested subagent model id; empty lets the agent choose. */
  model: string
  /** Suggested reasoning effort id; empty uses the model default. */
  effort: string
}

/** Product-wide advisory delegation preferences, independent of workspaces. */
export type SubagentPresets = {
  /** Language captured when saving the form, also used by the Host prompt. */
  language: 'zh' | 'en'
  /** Whether new requests receive the delegation guidance section. */
  enabled: boolean
  /** Large, medium, and small task tiers. */
  tiers: Record<'a' | 'b' | 'c', SubagentTier>
  /** Duties the main session keeps; unticked duties go to subagents. */
  mainDuties: Record<'read' | 'split' | 'delegate' | 'review' | 'merge' | 'release' | 'report' | 'small', boolean>
  /** Further main-session duties in free text. */
  otherMainDuties: string
  /** Whether subagents may delegate to their own subagents. */
  allowNested: boolean
  /** When a subagent may delegate further, in each product language. */
  nestedCondition: DelegationText
}

/** Absence means remind and not yet selected; chosen records explicit confirmation. */
export interface ProjectSelection {
  /** Opening policy applied to matching seat projects after explicit confirmation. */
  mode: 'off' | 'remind' | 'auto'
  /** Whether the user explicitly confirmed this workspace choice. */
  chosen: boolean
}
