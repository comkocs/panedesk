/** Client registration for owner-authorized seat resources and optional entry slots. */
import type { Context } from '@panedesk/cordis'
import remote from '@panedesk/dsh-client-ui-seats/remote'
import { createSnapshotStore } from '@panedesk/dsh-client-store'
import { randomUUID } from '@panedesk/dsh-util-crypto'
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

export type { SeatKey } from './locales.ts'

declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { seats: SeatKey }
}

/** Explicit service dependencies for resources, navigation and draft initialization. */
export const inject = ['remote', 'resources', 'slots', 'locale', 'uiWorkspace', 'conversation', 'sessions']

/** Mount generated calls and reversible seat UI contributions.
 * @param ctx - Owning Client fiber; components never receive it.
 * @returns Cleanup that withdraws the generated namespace after dependent contributions stop.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const sessions = ctx.get('sessions') as ISessions
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
        notify(value.error.details?.agentPreset !== undefined
          ? t('missingPreset', { preset: value.error.details.agentPreset, code: value.error.code })
          : t('openFailed', { reason: `${value.error.code}: ${value.error.message} ${value.error.alternative}${directoryRefused ? ` ${t('directoryRefused')}` : ''}` }))
      }
      else if (value.status !== 'cancelled') notify(t('openFailed', { reason: value.status }))
      refresh()
    }
    const injected = (): SeatsInjected => ({ openSeat, openWindow,
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
