/** One platform-aware deployment-mode decision, shared by every composed consumer. */
import type { SandboxMode } from '@panedesk/dsh-sandbox'
import { SANDBOX_MODES } from './session-mode.ts'

/** Resolved mode with the distinction needed by first-write authorization. */
export interface EffectivePermissionMode {
  mode: SandboxMode
  source: 'default' | 'explicit'
}

/**
 * Resolve an explicit configuration/environment choice before platform defaults.
 * @param mode - Explicit configured mode, absent to consult the environment.
 * @param environment - Launch environment mode, absent for the platform default.
 * @param platform - Execution platform, injectable without changing global process state.
 * @returns The effective deployment mode and whether the operator selected it.
 */
export function resolveEffectivePermissionMode(
  mode?: SandboxMode,
  environment: string | undefined = process.env.PANEDESK_PERMISSION_MODE,
  platform: string = process.platform,
): EffectivePermissionMode {
  const explicit = mode ?? environment
  if (explicit !== undefined) {
    if (!SANDBOX_MODES.includes(explicit as SandboxMode)) throw new Error('PANEDESK_PERMISSION_MODE must be read-only, workspace-write, or danger-full-access')
    return { mode: explicit as SandboxMode, source: 'explicit' }
  }
  return { mode: platform === 'win32' ? 'read-only' : 'workspace-write', source: 'default' }
}
