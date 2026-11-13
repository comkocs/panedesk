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

/** One advisory model choice, ordered within its task tier. */
export type SubagentModel = {
  /** LLM provider id passed to the subagent tool. */
  provider: string
  /** Model id passed to the subagent tool. */
  model: string
  /** Reasoning effort id; empty uses the model default. */
  effort: string
  /** Optional task-size band; all applies to every size. */
  size: 'all' | 'large' | 'medium' | 'small'
}

/** One task tier's criteria and ordered model preferences. */
export type SubagentTier = {
  /** When a task belongs to this tier, in each product language. */
  criteria: DelegationText
  /** Model choices in priority order; an empty list lets the agent choose. */
  models: SubagentModel[]
  /** Legacy provider id, read only when converting an older single-model preference. */
  provider?: string
  /** Legacy model id, read as the first all-size model when nonempty. */
  model?: string
  /** Legacy reasoning effort, discarded after conversion to the model list. */
  effort?: string
}

/** Optional size rules, independent of task complexity tiers. */
export type SubagentSizes = {
  /** Whether prompts and forms subdivide each tier by task size. */
  enabled: boolean
  /** Editable large-task rule in both product languages. */
  large: DelegationText
  /** Editable medium-task rule in both product languages. */
  medium: DelegationText
  /** Editable small-task rule in both product languages. */
  small: DelegationText
}

/** Product-wide advisory delegation preferences, independent of workspaces. */
export type SubagentPresets = {
  /** Language captured when saving the form, also used by the Host prompt. */
  language: 'zh' | 'en'
  /** Whether new requests receive the delegation guidance section. */
  enabled: boolean
  /** Complexity tiers A, B, and C, each with an ordered model list. */
  tiers: Record<'a' | 'b' | 'c', SubagentTier>
  /** Optional large, medium, and small task rules, disabled by default. */
  sizes: SubagentSizes
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
