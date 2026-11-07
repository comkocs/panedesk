/** Launcher-owned profile locations and composition inputs. */
import { join } from 'node:path'
import { composeEntries, loadProfileDirectory, PROFILE_PATCH_FILENAME, type Profile } from './profile.ts'
import { loadOptionalPatches } from './index.ts'
import type { PatchOptions } from '@panedesk/cordis-plugin-include'

/** Application-owned package manager executable; environment applies only to package operations. */
export interface ProfilePnpmInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** Current profile facts; scheduling and mutation belong to their callers. */
export interface ProfileContext {
  readonly name: string
  /** Packaged applications supply their bundled runtime instead of a PATH executable. */
  readonly packageManager?: ProfilePnpmInvocation
  readonly dir: string
  readonly patchPath: string
  readonly installAnchor: string
  readonly cwd: string
  readonly home: string
  /** Bundle packages used to start this process, before any persisted edits. */
  readonly startedBundles: readonly string[]
  /** Parsed command-line overlays, applied above profile and home patches. */
  readonly overlays: readonly PatchOptions[]
  /** Command-line patch files read at launch; their parsed contents remain frozen. */
  readonly overlayPaths?: readonly string[]
  /** Launch-time PANEDESK_TELEMETRY_DISABLED value; any non-empty value opts out. */
  readonly telemetryDisabledEnv: string | undefined
}

declare module '@panedesk/cordis' {
  interface Context {
    /** Present only in a profile launched by dsh. */
    profileContext: ProfileContext
  }
}

const TELEMETRY_ROW_ID = 'session-telemetry-otel'
const PRODUCT_ANALYTICS_ROW_IDS = ['desktop-product-telemetry', 'product-analytics'] as const

/**
 * Resolve the telemetry opt-out switch into its last-layer boot patches. ANY
 * non-empty value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without a matching row
 * exports nothing for that row, so the switch is then trivially satisfied and
 * no patch is generated for it — custom profiles need not mount telemetry to
 * run with the switch set.
 * @param disabledEnv - the raw `PANEDESK_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param presentIds - row ids the composition already carries.
 * @returns last-layer disable patches for the present telemetry rows, or an empty list when the switch is unset.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, presentIds: ReadonlySet<string>): PatchOptions[] {
  if ((disabledEnv ?? '') === '') return []
  const ids = [TELEMETRY_ROW_ID, ...PRODUCT_ANALYTICS_ROW_IDS].filter(id => presentIds.has(id))
  return ids.map(id => ({ id, disabled: true }))
}

/** Read the selected bundles' patches, which apply before the profile patch file.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Bundle patches in application order.
 */
export function readBundlePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const profile = initialProfile ?? loadProfileDirectory(binName, context.dir, context.installAnchor, { userLayer: false })
  return profile.layers.flatMap(layer => layer.patches)
}

/** Read current bundle and user layers with the launch-time overlays.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Detached ordered patches; this function does not update the Loader.
 */
export function readProfilePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const patches = structuredClone([
    ...readBundlePatches(binName, context, initialProfile),
    ...(initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? []),
    ...(loadOptionalPatches(binName, join(context.home, PROFILE_PATCH_FILENAME)) ?? []),
    ...context.overlays,
  ])
  const composed = composeEntries([patches])
  const presentIds = new Set(composed.map(row => row.id))
  patches.push(...resolveTelemetryPatch(context.telemetryDisabledEnv, presentIds))
  return patches
}
