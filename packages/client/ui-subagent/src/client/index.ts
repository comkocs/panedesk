/** Web subagent catalog, navigation, and addressed-session composer owner. */
import type { Context as ClientContext } from '@panedesk/cordis'
import type { SubagentAddress } from '@panedesk/dsh-subagent/client'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { ComposerChainProps } from '@panedesk/dsh-client-ui-conversation/client'
import { SubagentCatalogAction, SubagentHeaderLineage, type SubagentCatalogInjected } from './SubagentHeaderLineage.tsx'
import {
  SubagentReadOnlyComposer, type SubagentReadOnlyMatch,
} from './SubagentReadOnlyComposer.tsx'
import { registerSidebarChat, subagentChatAddress } from './sidebar-chat/index.tsx'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-ui-chat/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type {} from '@panedesk/dsh-client-ui-session/client'
import type {} from '@panedesk/dsh-client-ui-sidebar-right/client'
import type {} from '@panedesk/dsh-client-ui-workspace/client'
import { SubagentTaskFlow, SubagentTaskPreview, SubagentTreeDetails } from './SubagentTaskPreview.tsx'
import { AgentMap, type AgentMapInjected } from './AgentMap.tsx'
import type {} from '@panedesk/dsh-api-job-controller/client'
import type {} from '@panedesk/dsh-client-ui-subagent-tree/client'
import { en, NS, zh, type SubagentKey } from './locales.ts'

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Subagent catalog and read-only composer copy. */
    'subagent': SubagentKey
  }
}

export type {
  SubagentCatalogActionProps, SubagentCatalogInjected, SubagentHeaderLineageProps,
} from './SubagentHeaderLineage.tsx'
export type {
  SubagentReadOnlyComposerProps, SubagentReadOnlyMatch,
} from './SubagentReadOnlyComposer.tsx'

/** Required services for subagent presentation and navigation. */
export const inject = ['sessions', 'uiWorkspace', 'slots', 'locale', 'sidebarRight', 'jobs', 'subagentTreeUI']

/** Claim the composer for one-shot history or an unavailable continuation owner. */
function selectReadOnlySubagent(owner: ComposerChainProps): SubagentReadOnlyMatch | null {
  const subagent = owner.session?.subagent
  if (subagent === undefined || subagent === null) return null
  if (subagent.address.mode === 'unknown') return { reason: 'unknown' }
  if (subagent.address.mode === 'one-shot') return { reason: 'one-shot' }
  // Until a Host summary establishes parent availability, keep the normal
  // disabled composer instead of claiming that the parent is offline.
  if (subagent.parentAvailable !== false) return null
  // A RUNNING parent-offline continuable child keeps the default composer:
  // its input is disabled there, but the same primary Stop stays available so
  // the child can be interrupted. Once it stops, this takeover returns.
  return owner.session?.running === true ? null : { reason: 'parent-unavailable' }
}

/**
 * Client plugin body: register the subagent catalog and read-only composer seats.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-subagent: dictionaries')
  ctx.inject(['resources', 'sidebarRightTabs'], (scope) => {
    registerSidebarChat(scope, ctx.locale.bind(NS))
  })
  ctx.slots.registerFactory({
    name: 'subagent.task-preview',
    scope: 'root',
    locale: NS,
    children: { 'subagent.task-preview.flow': { kind: 'single', scope: 'session' } },
  }, SubagentTaskPreview)
  ctx.slots.inject('subagent.task-preview.flow', () => ctx.slots.register({
    name: 'subagent.task-preview.flow',
    locale: NS,
  }, SubagentTaskFlow))
  const openChildAside = (address: SubagentAddress): void => {
    ctx.sidebarRight.openResource(subagentChatAddress(address), {
      kind: 'subagentchat',
      floating: true,
    })
  }
  const catalogActions = (_parentSessionId: SessionId): SubagentCatalogInjected => ({
    openChild: openChildAside,
    openChildAside,
    refreshProjection(parentSessionId: SessionId) {
      void ctx.sessions.refreshProjections(parentSessionId)
    },
  })
  ctx.slots.inject('subagent.tree.details', () => ctx.slots.register({
    name: 'subagent.tree.details',
    locale: NS,
    inject: (sessionId: SessionId): Pick<SubagentCatalogInjected, 'openChild'> => ({
      openChild: address => ctx.sidebarRight.openResourceIn(sessionId, subagentChatAddress(address), {
        kind: 'subagentchat', floating: true,
      }),
    }),
  }, SubagentTreeDetails))
  ctx.slots.inject(
    'conversation.session.header.lineage',
    () => ctx.slots.register({
      name: 'conversation.session.header.lineage',
      locale: NS,
      inject: catalogActions,
    }, SubagentHeaderLineage),
  )
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'subagent-catalog',
      // Between the preset label (-10) and background tasks (20), after Team
      // navigation (-20).
      order: 10,
      locale: NS,
      inject: catalogActions,
    }, SubagentCatalogAction),
  )
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'agent-map',
    order: 10,
    locale: NS,
    inject: (sessionId: SessionId): AgentMapInjected => ({
      ...catalogActions(sessionId),
      hooks: { jobs: ctx.jobs.state },
      watchRows: id => ctx.jobs.watchRows(id),
      observe: (id, jobId) => ctx.jobs.observe(id, jobId),
      treeAddress: ctx.subagentTreeUI.address,
      modelColor: ctx.subagentTreeUI.modelColor,
      isActive: ctx.subagentTreeUI.isActive,
      stopAgent: node => ctx.subagentTreeUI.stop(node),
      killJob: async (id, jobId) => {
        const result = await ctx.jobs.kill(id, jobId)
        if (!result.ok) throw result.error
      },
    }),
  }, AgentMap))
  ctx.slots.inject(
    'conversation.composer',
    () => ctx.slots.register({
      name: 'conversation.composer',
      priority: -10,
      locale: NS,
      select: selectReadOnlySubagent,
    }, SubagentReadOnlyComposer),
  )
}
