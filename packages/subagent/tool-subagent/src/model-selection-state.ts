/** Durable per-session state for the user-controlled model-selection opt-in. */

import { z as zod } from 'zod'
import type { Context } from '@panedesk/cordis'
import type { Agent } from '@panedesk/dsh-agent'
import type { Session, SessionId } from '@panedesk/dsh-session'
import type SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import type { ProjectionDefinition } from '@panedesk/dsh-session-projection'
import { assertAllowedModelRoutes, type AllowedModelRoute } from './model-selection.ts'

declare module '@panedesk/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records that this session's delegation tool exposes child provider,
     * model, and reasoning-effort selection. Appended before the first model
     * request; absence means the fixed-route definition. Log-only: it carries
     * no `surfaceOp` and never enters model history.
     */
    'subagent/model-selection-policy': {
      /** Exact routes this Session may select explicitly for a child. */
      allowedModels: AllowedModelRoute[]
    }
    /**
     * Records that this child was started on a route that declares no reasoning
     * efforts, so the requested effort was not sent. Log-only: it carries no
     * `surfaceOp` and never enters model history. Cards read it as
     * "effort not applicable".
     */
    'subagent/effort-not-applicable': {
      /** Provider route the child was started on. */
      provider: string
      /** Provider-owned model id the child was started on. */
      model: string
    }
  }
}

declare module '@panedesk/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Exact routes authorized for child LLM selection, or null when disabled. */
    subagentModelSelectionPolicy: AllowedModelRoute[] | null
  }
}

const modelSelectionPolicySchema: zod.ZodType<AllowedModelRoute[] | null> = zod.array(zod.object({
  provider: zod.string().min(1),
  model: zod.string().min(1),
}).strict()).min(1).nullable()

/** Host-only projection of the durable model-selection policy. */
export const subagentModelSelectionProjectionDefinition = {
  key: 'subagentModelSelectionPolicy',
  stateVersion: 1,
  stateSchema: modelSelectionPolicySchema,
  init: () => null,
  apply: (policy, event) => {
    if (policy !== null || event.type !== 'subagent/model-selection-policy') return policy
    const { allowedModels } = event.data
    assertAllowedModelRoutes(allowedModels)
    if (allowedModels.length === 0) {
      throw new Error('subagent/model-selection-policy requires at least one route')
    }
    return allowedModels
  },
} satisfies ProjectionDefinition<'subagentModelSelectionPolicy', AllowedModelRoute[] | null>

/**
 * Read the exact route list captured for a model-selectable definition.
 * @param projections - registry that owns the policy projection.
 * @param session - session whose durable decision is read.
 * @returns a detached route list, or undefined for the fixed-route definition.
 */
export function subagentModelSelectionPolicy(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
): AllowedModelRoute[] | undefined {
  return projections.stateOf(session, 'subagentModelSelectionPolicy')?.map(route => ({ ...route }))
}

/** One pending "effort not applicable" note, waiting for its child session. */
interface PendingEffortNote {
  /** Parent session the delegation started from. */
  readonly parentId: SessionId
  /** Route the note belongs to. */
  readonly route: AllowedModelRoute
}

/**
 * Remember that the next child this parent starts on `route` declares no
 * reasoning efforts. The note is written into that child's own log before its
 * first request header, which is the only place the cards read model labels.
 * @param ctx - Host context shared by the parent and its children.
 * @param parent - delegating parent agent.
 * @param route - winning route that declares no selectable efforts.
 */
export function noteEffortNotApplicable(ctx: Context, parent: Agent, route: AllowedModelRoute): void {
  const notes = pendingEffortNotes(ctx)
  notes.push({ parentId: parent.session.header.id, route })
  if (notes.length > 1) return
  // The child is created before its first request, so the note lands ahead of
  // the request header the cards read.
  ctx.on('agent/created', ({ agent }) => {
    const parentId = agent.session.header.parentSession
    const { provider, model } = agent.options
    if (parentId === undefined || provider === undefined || model === undefined) return
    const queue = pendingEffortNotes(ctx)
    const index = queue.findIndex(note => note.parentId === parentId
      && note.route.provider === provider && note.route.model === model)
    const note = index < 0 ? undefined : queue[index]
    if (note === undefined) return
    queue.splice(index, 1)
    agent.session.append('subagent/effort-not-applicable', { provider: note.route.provider, model: note.route.model })
  })
}

/**
 * Process-local queue of notes not yet written into a child log. Keyed by the
 * root context so parent and child fibers of one host share one queue, and a
 * disposed host drops its queue with the context.
 */
function pendingEffortNotes(ctx: Context): PendingEffortNote[] {
  const carrier = ctx.root ?? ctx
  const stored = effortNoteQueues.get(carrier)
  if (stored !== undefined) return stored
  const created: PendingEffortNote[] = []
  effortNoteQueues.set(carrier, created)
  return created
}

const effortNoteQueues = new WeakMap<Context, PendingEffortNote[]>()

/**
 * Append the route policy once, before its definition can reach a model request.
 * @param projections - registry that owns the policy projection.
 * @param session - session receiving the model-selectable definition.
 * @param allowedModels - exact routes the definition may select explicitly.
 */
export function recordSubagentModelSelection(
  projections: Pick<SessionProjectionRegistry, 'stateOf'>,
  session: Session,
  allowedModels: readonly AllowedModelRoute[],
): void {
  if (subagentModelSelectionPolicy(projections, session) !== undefined) return
  session.append('subagent/model-selection-policy', {
    allowedModels: allowedModels.map(route => ({ ...route })),
  })
}
