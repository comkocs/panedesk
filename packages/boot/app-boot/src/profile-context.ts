/** Launcher-owned profile locations and composition inputs. */
import { join, resolve } from 'node:path'
import { ProtectedInputIntegrity } from './input-integrity.ts'
import { composeEntries, loadProfileDirectory, PROFILE_PATCH_FILENAME, type Profile } from './profile.ts'
import { loadOptionalPatches } from './index.ts'
import type { PatchOptions } from '@panedesk/cordis-plugin-include'

import type { ProfileContext } from './profile-context-types.ts'
export type { ProfileContext, ProfilePnpmInvocation } from './profile-context-types.ts'

/**
 * Establish host input trust before the caller publishes workspace write access.
 * @param context Launcher-owned profile and record inventory.
 * @param workspace Actual sandbox write root, not necessarily the launch directory.
 * @param paths Current protected input spellings, including Loader links.
 */
export function grantProtectedWorkspace(context: ProfileContext, workspace: string, paths: readonly string[]): void {
  const root = resolve(workspace)
  const records = context.inputIntegrities ??= new Map()
  let integrity = records.get(root)
  if (integrity === undefined) {
    integrity = root === resolve(context.cwd) && context.inputIntegrity !== undefined
      ? context.inputIntegrity : new ProtectedInputIntegrity(root, context.home)
    records.set(root, integrity)
  }
  for (const path of [context.dir, join(context.dir, 'package.json'), context.patchPath, join(context.home, PROFILE_PATCH_FILENAME),
    ...context.bundleInputPaths ?? [], ...context.overlayPaths ?? [],
    ...context.protectedInputPaths?.() ?? [], ...paths]) integrity.observe(path)
  integrity.grantWrite()
}

/**
 * Query the host fallback inventory without creating or approving a baseline.
 * @param context Launcher-owned profile inventory.
 * @param filename Protected path spelling supplied by a confinement backend.
 * @returns Whether a recorded writable workspace covers this input.
 */
export function protectedInputCovered(context: ProfileContext, filename: string): boolean {
  return context.inputIntegrity?.covers(filename) === true
    || [...context.inputIntegrities?.values() ?? []].some(integrity => integrity.covers(filename))
}

const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `PANEDESK_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/** Read the selected bundles' patches, which apply before the profile patch file.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Bundle patches in application order.
 */
export function readBundlePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const profile = initialProfile ?? loadProfileDirectory(binName, context.dir, context.installAnchor, {
    userLayer: false,
    ...context.inputIntegrity === undefined ? {} : { integrity: context.inputIntegrity },
  })
  context.bundleInputPaths = [...new Set([
    ...context.bundleInputPaths ?? [],
    ...profile.layers.flatMap(layer => [join(layer.packageDir, 'package.json'), ...layer.patchPaths]),
  ])]
  for (const path of context.bundleInputPaths) context.inputIntegrity?.observe(path)
  return profile.layers.flatMap(layer => layer.patches)
}

/** Read current bundle and user layers with the launch-time overlays.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Detached ordered patches; this function does not update the Loader.
 */
export function readProfilePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const integrity = context.inputIntegrity ??= new ProtectedInputIntegrity(context.cwd, context.home)
  for (const path of [join(context.dir, 'package.json'), context.patchPath,
    join(context.home, PROFILE_PATCH_FILENAME), ...context.overlayPaths ?? []]) integrity.observe(path)
  const patches = structuredClone([
    ...readBundlePatches(binName, context, initialProfile),
    ...(initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath, integrity) ?? []),
    ...(loadOptionalPatches(binName, join(context.home, PROFILE_PATCH_FILENAME), integrity) ?? []),
    ...context.overlays,
  ])
  const telemetryPatch = resolveTelemetryPatch(context.telemetryDisabledEnv,
    composeEntries([patches]).some(row => row.id === TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) patches.push(telemetryPatch)
  return patches
}
