/** Client registration for owner-authorized seat resources and optional entry slots. */
import type { Context } from '@panedesk/cordis'
import remote from '@panedesk/dsh-client-ui-seats/remote'
import { createSnapshotStore } from '@panedesk/dsh-client-store'
import { randomUUID } from '@panedesk/dsh-util-crypto'
import { z } from 'zod'
import type { ConnectionHandle } from '@panedesk/dsh-client-connection/client'
import type { PreviewSeatImportRequest } from '@panedesk/dsh-seat/types'
import type { SeatAddPlan, SeatAddRequest } from '../types.ts'
import type {} from '@panedesk/dsh-api-remotes/client'
import type {} from '@panedesk/dsh-api-remotes/types'
import type {} from '@panedesk/dsh-client-resources/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type {} from '@panedesk/dsh-client-ui-workspace/client'
import type {} from '@panedesk/dsh-client-ui-conversation/client'
import type { ISessions } from '@panedesk/dsh-api-session-controller/client'
import type { SeatDefinition, SeatOperationId } from '@panedesk/dsh-seat/types'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { SeatOverview } from '../types.ts'
import { SeatHeader, SeatPicker, SeatsSection, type SeatsInjected } from './Seats.tsx'
import { en, zh, type SeatKey } from './locales.ts'
import { Overview } from './Overview.tsx'
import type { MainPanelId } from '@panedesk/dsh-client-ui-layout/client'
import type {} from '@panedesk/dsh-client-ui-seat-profiles/client'
import type { SeatName } from '@panedesk/dsh-seat/types'

declare module '@panedesk/cordis' {
  interface Context {
    seatDeskNavigation: { openSeat(seat: SeatName): void }
  }
}

export type { SeatKey } from './locales.ts'

const addPlan = z.object({
  planId: z.custom<SeatAddPlan['planId']>(value => typeof value === 'string' && value.length > 0),
  baseRevision: z.number().int().nonnegative(),
  rows: z.array(z.object({ row: z.number().int().nonnegative(),
    action: z.enum(['create', 'update', 'retain', 'conflict', 'tombstone', 'invalid']), diagnostics: z.array(z.unknown()) })),
})
const addCommit = z.object({ status: z.literal('committed') })

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { seats: SeatKey }
  interface ResourceProtocolMap { 'seat-dashboard': import('@panedesk/dsh-seat-local/types').SeatProfileSnapshot }
}

/** Explicit service dependencies for resources, navigation and draft initialization. */
export const inject = ['remote', 'remote.session', 'connection', 'resources', 'slots', 'locale', 'uiWorkspace', 'conversation', 'sessions']

/** Mount generated calls and reversible seat UI contributions.
 * @param ctx - Owning Client fiber; components never receive it.
 * @returns Cleanup that withdraws the generated namespace after dependent contributions stop.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const sessions = ctx.get('sessions') as ISessions
  const connection = ctx.get('connection') as ConnectionHandle
  const unmount = await ctx.remote.$mount(remote)
  const mounted = ctx.inject(['remote.seatUi'], (ctx) => {
    ctx.effect(() => ctx.locale.register('seats', { en, zh }), 'ui-seats: locale')
    const notice = createSnapshotStore<{ seq: number; message: string; sessionId?: SessionId } | null>(null)
    let sequence = 0
    const notify = (message: string, sessionId?: SessionId): void => {
      notice.set({ seq: ++sequence, message, ...(sessionId === undefined ? {} : { sessionId }) })
    }
    const t = ctx.locale.bind('seats')
    const refreshers = new Set<() => void>()
    const refresh = (): void => { for (const listener of refreshers) listener() }
    ctx.on('connection/reset', refresh)
    ctx.effect(() => ctx.resources.register<'seats'>({
      protocol: 'seats',
      async *open(address, { signal }) {
        const sessionId = new URL(address).searchParams.get('session') as SessionId | null
        let revision = 0
        let wake: (() => void) | undefined
        const invalidate = (): void => { revision++; wake?.() }
        refreshers.add(invalidate)
        const stops = [
          ctx.remote.$on('api-session/added', invalidate),
          ctx.remote.$on('api-session/removed', invalidate),
          ctx.remote.$on('api-session/status', invalidate),
          ctx.remote.$on('seat/diagnostics-changed', invalidate),
        ]
        signal.addEventListener('abort', invalidate, { once: true })
        const aborted = (): boolean => signal.aborted
        let verified: SeatOverview['binding']
        try {
          while (!aborted()) {
            const observed = revision
            const result = await ctx.remote.seatUi.overview(sessionId ?? undefined, signal)
            if (result.ok) {
              const overview = result.value
              const binding = overview.binding
              if (binding && 'kind' in binding && binding.sessionId === sessionId) verified = binding
              else if (overview.identityStatus !== 'failed') verified = undefined
              yield overview.identityStatus === 'failed' && verified !== undefined
                ? { ...result, value: { ...overview, binding: verified } } : result
            } else yield result
            if (aborted()) break
            if (revision === observed) await new Promise<void>((resolve) => {
              wake = resolve
              if (signal.aborted || revision !== observed) resolve()
            })
            wake = undefined
          }
        } finally {
          signal.removeEventListener('abort', invalidate)
          refreshers.delete(invalidate)
          for (const stop of stops) stop()
        }
      },
    }), 'ui-seats: resource')
    ctx.effect(() => ctx.remote.$on('seat/memory-write-denied', (sessionId, failure) => {
      notify(t('memoryDenied', { code: failure.code, reason: `${failure.message} ${failure.alternative}` }), sessionId)
    }), 'ui-seats: memory refusal')
    const openWindow = (id: SessionId): void => { ctx.uiWorkspace.openSession(id) }
    const closeWindow: SeatsInjected['closeWindow'] = async (sessionId, stateVersion) => {
      const result = await ctx.remote.seatUi.close({ sessionId, expectedStateVersion: stateVersion,
        operationId: `seat-ui:${randomUUID()}` as SeatOperationId })
      if (!result.ok) notify(t('closeFailed', { reason: result.error.message }), sessionId)
      else if (result.value.status !== 'closed') {
        const value = result.value
        notify(t('closeFailed', { reason: value.status === 'rejected'
          ? `${value.error.code}: ${value.error.message} ${value.error.alternative}` : value.status }), sessionId)
      }
      refresh()
    }
    const openSeat = async (seat: SeatDefinition, startupDirectory?: string): Promise<void> => {
      const result = await ctx.remote.seatUi.open({ seat: seat.seat, expectedSeatRevision: seat.revision,
        ...(startupDirectory === undefined ? {} : { startupDirectory }),
        operationId: `seat-ui:${randomUUID()}` as SeatOperationId })
      if (!result.ok) { notify(t('openFailed', { reason: result.error.message })); return }
      const value = result.value
      if (value.status === 'prefilled') {
        openWindow(value.sessionId)
        const binding = sessions.binding(value.sessionId)
        if (binding === undefined || ctx.conversation.input.requestDraftInitialization(binding, { prompt: value.draft }) === 'blocked') {
          notify(t('openFailed', { reason: t('unavailable') }))
        }
      } else if (value.status === 'switched') openWindow(value.window.sessionId)
      else if (value.status === 'choice-required') notify(t('existingChoice'))
      else if (value.status === 'rejected') {
        const directoryRefused = startupDirectory !== undefined && value.error.code === 'invalid-request'
        notify(value.error.details !== undefined && 'agentPreset' in value.error.details
          ? t('missingPreset', { preset: value.error.details.agentPreset, code: value.error.code })
          : t('openFailed', { reason: `${value.error.code}: ${value.error.message} ${value.error.alternative}${directoryRefused ? ` ${t('directoryRefused')}` : ''}` }))
      }
      else if (value.status !== 'cancelled') notify(t('openFailed', { reason: value.status }))
      refresh()
    }
    const loadModels: SeatsInjected['loadModels'] = async () => {
      const result = await ctx.remote.session.modelCatalog()
      if (!result.ok) throw new Error(result.error.message)
      return result.value.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id,
        label: `${group.name} / ${model.name}`,
        ...(model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: model.reasoning.defaultEffort }) })))
    }
    const prepareAdd = async (request: SeatAddRequest): Promise<PreviewSeatImportRequest> => {
      const result = await ctx.remote.seatUi.prepareAdd(request)
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
      return result.value
    }
    const previewAdd = async (request: PreviewSeatImportRequest): Promise<SeatAddPlan> => {
      const result = await connection.rpc.call('/api', 'seats/import.preview', { args: { request } })
      if (!result.ok) throw new Error(result.error.message)
      return addPlan.parse(result.value)
    }
    const addOperations = new Map<string, SeatOperationId>()
    const commitAdd = async (plan: SeatAddPlan): Promise<void> => {
      const key = JSON.stringify({ planId: plan.planId, baseRevision: plan.baseRevision })
      const operationId = addOperations.get(key) ?? `seat-ui:${randomUUID()}` as SeatOperationId
      addOperations.set(key, operationId)
      const request = { planId: plan.planId, expectedRevision: plan.baseRevision,
        selectedRows: plan.rows.filter(row => row.action === 'create').map(row => row.row), operationId }
      try {
        const result = await connection.rpc.call('/api', 'seats/import.commit', { args: { request } })
        if (!result.ok) throw new Error(result.error.message)
        if (typeof result.value === 'object' && result.value !== null && 'status' in result.value && result.value.status === 'rejected') {
          addOperations.delete(key)
          throw Object.assign(new Error(t('commitRejected')), { name: 'SeatWriteRejected' })
        }
        addCommit.parse(result.value)
        addOperations.delete(key)
      } finally { refresh() }
    }
    const dashboardRefreshers = new Set<() => void>()
    const refreshDashboard = (): void => { for (const listener of dashboardRefreshers) listener() }
    ctx.on('connection/reset', refreshDashboard)
    ctx.effect(() => ctx.remote.$on('seat/diagnostics-changed', refreshDashboard))
    ctx.effect(() => ctx.resources.register<'seat-dashboard'>({
      protocol: 'seat-dashboard',
      async *open(_address, { signal }) {
        let revision = 0, wake: (() => void) | undefined
        const invalidate = (): void => { revision++; wake?.() }
        dashboardRefreshers.add(invalidate)
        signal.addEventListener('abort', invalidate, { once: true })
        try {
          while (!signal.aborted) {
            const observed = revision
            yield await ctx.remote.seatUi.dashboard(signal)
            if (revision === observed) await new Promise<void>((resolve) => {
              wake = resolve
              if (signal.aborted || revision !== observed) resolve()
            })
            wake = undefined
          }
        } finally { dashboardRefreshers.delete(invalidate); signal.removeEventListener('abort', invalidate) }
      },
    }))
    ctx.inject(['layout'], (scope) => {
      const batchOperations = new Map<string, SeatOperationId>()
      scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: 'seat-overview' as MainPanelId,
        locale: 'seats', inject: () => ({ refresh: refreshDashboard,
          batch: async (seats: readonly SeatName[]) => {
            try {
              const key = JSON.stringify([...seats].sort())
              const operationId = batchOperations.get(key) ?? `seat-ui:${randomUUID()}` as SeatOperationId
              batchOperations.set(key, operationId)
              const result = await ctx.remote.seatUi.openBatch({ seats, operationId })
              if (!result.ok) throw new Error(result.error.message)
              if (result.value.status === 'rejected') {
                batchOperations.delete(key)
                throw Object.assign(new Error(result.value.error.message), { name: 'SeatWriteRejected' })
              }
              let failed = false
              for (const item of result.value.results) {
                const value = item.result
                if (value.status === 'prefilled') {
                  openWindow(value.sessionId)
                  const binding = sessions.binding(value.sessionId)
                  if (!binding || ctx.conversation.input.requestDraftInitialization(binding, { prompt: value.draft }) === 'blocked') failed = true
                } else if (value.status === 'switched') openWindow(value.window.sessionId)
                else failed = true
              }
              batchOperations.delete(key)
              if (failed) throw Object.assign(new Error(t('batchFailed')), { name: 'SeatWriteRejected' })
            } finally { refresh(); refreshDashboard() }
          },
        }),
      }, Overview))
    })
    const injected = (): SeatsInjected => ({ openSeat, openWindow, closeWindow, loadModels, prepareAdd, previewAdd, commitAdd,
      refreshSeats: refresh,
      openProfiles: (seat) => {
        const navigation = ctx.get('seatProfilesNavigation')
        if (navigation) navigation.open(seat)
        else notify(t('navigationUnavailable'))
      },
      openDesk: (seat) => {
        const navigation = ctx.get('seatDeskNavigation')
        if (navigation) navigation.openSeat(seat)
        else notify(t('navigationUnavailable'))
      },
      openOverview: () => {
        const layout = ctx.get('layout')
        if (layout) layout.selectPanel('seat-overview' as MainPanelId)
        else notify(t('navigationUnavailable'))
      },
      dismiss: () => { notice.set(null) },
      hooks: { seatNotice: notice } })
    ctx.slots.inject('conversation.hero.seat', () => ctx.slots.register({
      name: 'conversation.hero.seat', locale: 'seats', inject: injected,
    }, SeatPicker))
    ctx.slots.inject('sidebar.seats', () => ctx.slots.register({
      name: 'sidebar.seats', locale: 'seats', inject: injected,
    }, SeatsSection))
    ctx.slots.inject('conversation.header.seat', () => ctx.slots.register({
      name: 'conversation.header.seat', locale: 'seats', inject: injected,
    }, SeatHeader))
  })
  return async () => {
    await mounted.dispose()
    await unmount()
  }
}
