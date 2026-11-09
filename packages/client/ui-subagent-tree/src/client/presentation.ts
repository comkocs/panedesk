/** Shared tree/map presentation policy, exposed to other plugins through injection. */
import type { SubagentTreeNode } from '../types.ts'

const MODEL_COLORS = {
  claude: '#3987e5', gpt: '#d95926', glm: '#199e70', deepseek: '#c98500', other: '#d55181',
} as const

/**
 * Choose a model family by model identity, never by provider name.
 * @param model - observed model name, or null when unknown.
 * @returns the family color shared by the tree and map.
 */
export function modelColor(model: string | null): string {
  const name = model?.split(' · ').at(-1)?.toLowerCase() ?? ''
  const family = /claude|opus|sonnet|haiku/.test(name) ? 'claude'
    : /gpt|sol|astra|terra|luna/.test(name) ? 'gpt'
    : name.includes('glm') ? 'glm' : name.includes('deepseek') ? 'deepseek' : 'other'
  return MODEL_COLORS[family]
}

/**
 * Classify activity independently of model family.
 * @param status - observed node or shell status.
 * @returns whether the status dot is green.
 */
export function isActive(status: string): boolean {
  return status === 'running' || status === 'waiting' || status === 'stopping'
}

/** Injected UI operations shared by the tree and map. */
export interface SubagentTreeUI {
  /** Canonical resource address for one session's tree. */
  address(sessionId: SubagentTreeNode['sessionId']): string
  /** Color of the observed model family. */
  modelColor: typeof modelColor
  /** Whether the observed state is active. */
  isActive: typeof isActive
  /** Interrupt this node and all active descendants, child-first. Reject on failed admission. */
  stop(node: SubagentTreeNode): Promise<void>
}

declare module '@panedesk/cordis' {
  interface Context { subagentTreeUI: SubagentTreeUI }
}
