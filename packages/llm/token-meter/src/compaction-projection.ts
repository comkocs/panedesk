/** Client-visible compaction reservation derived from the mounted policy and logged request route. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@panedesk/dsh-session-projection'
import type {} from './projection.ts'

const stateSchema = z.object({
  provider: z.string(), model: z.string(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().nonnegative(),
}).strict()
type State = z.infer<typeof stateSchema>

declare module '@panedesk/dsh-session-projection/types' {
  interface SessionProjectionStateMap { contextCompaction: State }
}

/**
 * Create a display projection without changing the compaction trigger or model request.
 * @param policy - mounted configuration resolved for an exact logged provider and model.
 * @returns a projection whose reservation is the window minus its configured trigger.
 */
export function createContextCompactionProjection(
  policy: (target: { provider: string; model: string }) => { thresholdRatio: number; headroomTokens: number; auto: boolean },
) {
  return {
    key: 'contextCompaction', stateVersion: 1, stateSchema,
    init: () => ({ provider: '', model: '', maxTokens: 0 }),
    apply: (state, event) => {
      if (event.type === 'request/context') {
        const { provider, model, contextWindow } = event.data
        return { ...state, provider, model, contextWindow }
      }
      if (event.type === 'request/header') {
        const { provider, model, maxTokens = 0 } = event.data.header.config
        return { ...state, provider, model, maxTokens }
      }
      return state
    },
    wire: {
      viewSchema: z.object({ reserveTokens: z.number().int().nonnegative() }).strict(),
      view: state => {
        const configured = policy(state)
        const window = state.contextWindow ?? 0
        const threshold = Math.max(0, Math.floor(Math.min(
          window * configured.thresholdRatio, window - state.maxTokens - configured.headroomTokens,
        )))
        return { reserveTokens: configured.auto ? window - threshold : 0 }
      },
    },
  } satisfies ProjectionDefinition<'contextCompaction', State>
}
