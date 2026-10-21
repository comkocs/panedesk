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
}
