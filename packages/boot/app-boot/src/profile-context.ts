/** Launcher-owned profile locations and composition inputs. */
import { join } from 'node:path'
import { ProtectedInputIntegrity } from './input-integrity.ts'
import { composeEntries, loadProfileDirectory, PROFILE_PATCH_FILENAME, type Profile } from './profile.ts'
import { loadOptionalPatches } from './index.ts'
import type { PatchOptions } from '@panedesk/cordis-plugin-include'

import type { ProfileContext } from './profile-context-types.ts'
export type { ProfileContext, ProfilePnpmInvocation } from './profile-context-types.ts'

/**
 * Ensure existing host input trust, capturing only the first grant before write access is published.
 * @param context Launcher-owned profile and record inventory.
 * @param workspace Actual sandbox write root, not necessarily the launch directory.
 * @param paths Current protected input spellings, including Loader links.
 * @param signal Cancels this request without cancelling other waiters; omission waits until admission settles.
 * @returns Completion of durable capture or review; rejection must prevent publication of write access.
 */
export function grantProtectedWorkspace(
  context: ProfileContext, workspace: string, paths: readonly string[], signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  return workspaceReader(context, workspace, paths).ensureWrite([...context.protectedInputPaths?.() ?? [], ...paths], signal)
}

/**
 * Replace a baseline only after the calling host has authenticated explicit owner consent.
 * @param context Launcher-owned profile and reader inventory.
 * @param workspace Owner-selected writable directory.
 * @param paths Current native write exclusions.
 * @returns Capture completion; callers must not publish write access before it succeeds.
 */
export function regrantProtectedWorkspace(context: ProfileContext, workspace: string, paths: readonly string[]): Promise<void> {
  return workspaceReader(context, workspace, paths).grantWrite([...context.protectedInputPaths?.() ?? [], ...paths])
}

function workspaceReader(context: ProfileContext, workspace: string, paths: readonly string[]): ProtectedInputIntegrity {
  const root = ProtectedInputIntegrity.workspacePath(workspace)
  const key = ProtectedInputIntegrity.workspaceKey(root, context.home)
  const slots = context.workspaceInputReaders ??= new Map()
  const records = context.inputIntegrities ??= new Map()
  let integrity = slots.get(key)
  if (integrity === undefined) {
    const existing = records.get(root)
    integrity = existing?.ownsWorkspaceRecord(root, context.home) === true ? existing
      : context.inputIntegrity?.ownsWorkspaceRecord(root, context.home) === true ? context.inputIntegrity
        : new ProtectedInputIntegrity(root, context.home)
    slots.set(key, integrity)
  }
  records.set(root, integrity)
  for (const path of [context.dir, join(context.dir, 'package.json'), context.patchPath, join(context.home, PROFILE_PATCH_FILENAME),
    ...context.bundleInputPaths ?? [], ...context.overlayPaths ?? [],
    ...context.protectedInputPaths?.() ?? [], ...paths]) integrity.observe(path)
  return integrity
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
