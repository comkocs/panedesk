/** Launcher-owned profile locations and composition inputs. */
import { join, resolve } from 'node:path'
import { ProtectedInputIntegrity } from './input-integrity.ts'
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
  /** Launcher-owned approvals retained across HMR service replacements. */
  inputIntegrity?: ProtectedInputIntegrity
  /** Workspace-specific records owned by this launched profile, including non-launch session roots. */
  inputIntegrities?: Map<string, ProtectedInputIntegrity>
  /** Launcher-owned live inventory, evaluated before each workspace write grant. */
  protectedInputPaths?: () => readonly string[]
  /** Launcher-owned policy root for sessions without an explicit cwd. */
  protectedWorkspaceRoot?: () => string
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
  /** Bundle manifests and patches read by this process, retained across recompositions. */
  bundleInputPaths?: readonly string[]
  /** Launch-time PANEDESK_TELEMETRY_DISABLED value; any non-empty value opts out. */
  readonly telemetryDisabledEnv: string | undefined
}

declare module '@panedesk/cordis' {
  interface Context {
    /** Present only in a profile launched by dsh. */
    profileContext: ProfileContext
  }
}

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
