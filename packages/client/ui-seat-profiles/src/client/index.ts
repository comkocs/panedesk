/** Reversible settings section, owner Remote calls and shared profile observations. */
import type { Context } from '@panedesk/cordis'
import remote from '@panedesk/dsh-client-ui-seat-profiles/remote'
import { randomUUID } from '@panedesk/dsh-util-crypto'
import { z } from 'zod'
import Schema from '@panedesk/schemastery'
import type {} from '@panedesk/dsh-api-remotes/client'
import type {} from '@panedesk/dsh-client-resources/client'
import type {} from '@panedesk/dsh-client-locale/client'
import type {} from '@panedesk/dsh-client-ui-renderer/client'
import type {} from '@panedesk/dsh-client-ui-settings/client'
import type {
  SeatName, SeatOperationId, SeatRejected, SeatImportPlan, SeatCatalogMutationResult, CommitSeatImportResult,
} from '@panedesk/dsh-seat/types'
import type { SeatProfileSnapshot } from '../types.ts'
import { Profiles, type ProfileActions, type ImportPreset } from './Profiles.tsx'
import { createProfileStore } from './store.ts'
import { en, zh, type ProfileKey } from './locales.ts'

/** Product mappings contain column names only; they never change the generic parser. */
export interface Config { presets?: ImportPreset[] }
/** Validate product mappings before registering the editor. */
export const Config: Schema<Config> = Schema.object({
  presets: Schema.array(Schema.object({ id: Schema.string().required(), label: Schema.string().required(),
    columnMap: Schema.dict(Schema.string()).required() })).default([]),
})
/** Open the feature-owned editor inside Settings. */
export interface SeatProfilesNavigation {
  /** Open a particular seat's profile.
   * @param seat - Stable catalog identity.
   */
  open(seat: SeatName): void
}
declare module '@panedesk/cordis' {
  interface Context { seatProfilesNavigation: SeatProfilesNavigation }
}
declare module '@panedesk/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { seatProfiles: ProfileKey }
  interface ResourceProtocolMap { 'seat-profiles': SeatProfileSnapshot }
}
/** Required read, rendering and Remote facilities; settings navigation is optional. */
export const inject = ['remote', 'slots', 'locale', 'resources']

/** Register the editor only where Settings declares its section extension.
 * @param ctx - Client plugin lifecycle.
 * @param config - Product-owned mapping presets.
 * @returns Cleanup of dependent registrations before the Remote namespace.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(remote)
  const mounted = ctx.inject(['remote.seatProfiles'], (scope) => {
    scope.effect(() => scope.locale.register('seatProfiles', { en, zh }))
    const refreshers = new Set<() => void>()
    const refresh = (): void => { for (const listener of refreshers) listener() }
    scope.on('connection/reset', refresh)
    scope.effect(() => scope.remote.$on('seat/diagnostics-changed', refresh))
    scope.effect(() => scope.resources.register<'seat-profiles'>({
      protocol: 'seat-profiles',
      async *open(_address, { signal }) {
        let revision = 0, wake: (() => void) | undefined
        const invalidate = (): void => { revision++; wake?.() }
        refreshers.add(invalidate)
        signal.addEventListener('abort', invalidate, { once: true })
        try {
          while (!signal.aborted) {
            const observed = revision
            yield await scope.remote.seatProfiles.read(signal)
            if (observed === revision) await new Promise<void>((resolve) => {
              wake = resolve
              if (signal.aborted || observed !== revision) resolve()
            })
            wake = undefined
          }
        } finally { refreshers.delete(invalidate); signal.removeEventListener('abort', invalidate) }
      },
    }))
    const accepted = <V extends SeatImportPlan | SeatCatalogMutationResult | CommitSeatImportResult>(
      value: V,
    ): Exclude<V, SeatRejected> => {
      if ('status' in value && value.status === 'rejected') throw Object.assign(new Error(value.error.code), { name: 'SeatWriteRejected' })
      return value as Exclude<V, SeatRejected>
    }
    const pendingWrites = new Map<string, SeatOperationId>()
    const operation = (request: unknown): SeatOperationId => {
      const key = JSON.stringify(request)
      const id = pendingWrites.get(key) ?? randomUUID() as SeatOperationId
      pendingWrites.set(key, id)
      return id
    }
    const settled = (id: SeatOperationId): void => {
      for (const [key, value] of pendingWrites) if (value === id) pendingWrites.delete(key)
    }
    const face: ProfileActions = {
      presets: config.presets ?? [], refresh,
      takeover: async (expectedRevision) => {
        const operationId = operation({ kind: 'takeover', expectedRevision })
        const result = await scope.remote.seatProfiles.takeover({ expectedRevision, confirmed: true, operationId })
        if (!result.ok) throw new Error(result.error.code)
        settled(operationId)
        accepted(result.value)
        refresh()
      },
      save: async (definition, expectedRevision) => {
        const definitionJson = JSON.stringify(definition)
        const operationId = operation({ kind: 'save', definitionJson, expectedRevision })
        const result = await scope.remote.seatProfiles.save({ definitionJson, expectedRevision, operationId })
        if (!result.ok) throw new Error(result.error.code)
        settled(operationId)
        const receipt = accepted(result.value)
        refresh()
        return receipt.revision
      },
      remove: async (snapshot, seat) => {
        const windows = snapshot.windows.filter(item => item.seat === seat)
        const pending = snapshot.pending.filter(item => item.seat === seat)
        const request = { seat, expectedRevision: snapshot.revision, confirmed: true as const,
          engineSequence: snapshot.engineSequence,
          windows: windows.map(item => item.sessionId), pending: pending.map(item => item.queueItemId),
          windowVersions: windows.map(({ sessionId, stateVersion }) => ({ sessionId, stateVersion })),
          pendingVersions: pending.map(({ queueItemId, stateVersion }) => ({ queueItemId, stateVersion })) }
        const operationId = operation({ kind: 'remove', ...request })
        const result = await scope.remote.seatProfiles.deleteProfile({ ...request, operationId })
        if (!result.ok) throw new Error(result.error.code)
        settled(operationId)
        accepted(result.value)
        refresh()
      },
      preview: async (request) => {
        const rawMapping: unknown = JSON.parse(request.mapping), rawDefaults: unknown = JSON.parse(request.defaults)
        const columnMap = z.record(z.string(), z.string()).parse(rawMapping)
        const defaults = z.record(z.string(), z.unknown()).parse(rawDefaults)
        const result = await scope.remote.seatProfiles.preview({ sourcePath: request.sourcePath, format: request.format,
          columnMap, defaults, ...(request.table.trim() ? { table: request.table.trim() } : {}) })
        if (!result.ok) throw new Error(result.error.code)
        return accepted(result.value)
      },
      commit: async (plan, selectedRows) => {
        const operationId = operation({ kind: 'commit', planId: plan.planId, selectedRows, expectedRevision: plan.baseRevision })
        const result = await scope.remote.seatProfiles.commit({ planId: plan.planId, selectedRows,
          expectedRevision: plan.baseRevision, operationId })
        if (!result.ok) throw new Error(result.error.code)
        settled(operationId)
        accepted(result.value)
        refresh()
      },
    }
    scope.slots.inject('settings.section', function* () {
      const handle = createProfileStore(), instance = handle.create()
      const store: typeof handle = { ...handle, create: () => instance }
      yield scope.slots.register({ name: 'settings.section', id: 'seat-profiles', group: 'panedesk', order: 35,
        locale: 'seatProfiles', label: () => scope.locale.bind('seatProfiles')('nav'), store, inject: () => face }, Profiles)
      const dispose = scope.reflect.provide('seatProfilesNavigation', {
        open: (seat: SeatName) => {
          const navigation = scope.get('settingsNavigation')
          if (!navigation) throw new Error('Settings navigation is unavailable')
          instance.actions.select(seat)
          navigation.openSection('seat-profiles')
        },
      })
      yield () => { void dispose() }
    })
  })
  return async () => { await mounted.dispose(); await unmount() }
}
