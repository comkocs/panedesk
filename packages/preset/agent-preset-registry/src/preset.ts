import type { Volatile } from '@panedesk/cordis'
import type { PresetExecutionPolicy } from './definition.ts'
/** Public preset roster and selection configuration. */
/** One declared preset and its current activation failure, if any. */
export interface AgentPreset {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly broken?: string
  /** Imported type's mapped tool names; absent for ordinary presets. */
  readonly tools?: readonly string[]
  /** Preferred child model resolved against the live catalog at delegation. */
  readonly model?: string
  /** Preferred effort for the definition's model, not for an explicit override. */
  readonly reasoningEffort?: string
  /** Locally resolved execution policy; absent for an uncontrolled preset. */
  readonly executionPolicy?: PresetExecutionPolicy
  /** Lowercase SHA-256 of policy JSON with recursively sorted object keys, no whitespace, and unchanged array order. */
  readonly executionPolicyDigest?: string
}

/** Registry selection policy. */
export interface Config {
  /** Deployment default when the caller omits a preset. */
  default: string
  /** User-selected default; edited through Settings. */
  selectedDefault: Volatile<string | undefined>
  /** Read Claude Code agent types at startup; changes require a restart. */
  readClaudeAgentTypes: Volatile<boolean>
}
