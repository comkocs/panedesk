/** Launcher data declarations without importing the host boot implementation. */
import type { ProtectedInputIntegrity } from './input-integrity.ts'
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
  /** Host-owned composite identity slots; the path inventory above remains the confinement lookup. */
  workspaceInputReaders?: Map<string, ProtectedInputIntegrity>
  /** Launcher-owned live inventory, evaluated before each workspace write grant. */
  protectedInputPaths?: () => readonly string[]
  /** Launcher-owned policy root for sessions without an explicit cwd. */
  protectedWorkspaceRoot?: () => string
  /** Schedule owner review without blocking a refused configuration operation. */
  requestInputReview?: () => void
  /** Reload approved inputs through the active HMR transaction queue when available. */
  reloadProtectedInputs?: () => Promise<void>
  /** Serialize owner review with the active configuration transaction. */
  runInputReview?: (operation: () => Promise<void>) => Promise<void>
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
