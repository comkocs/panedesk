/** Resolve runtime-only ledger attribution without extending Session headers. */
import type { Context } from '@panedesk/cordis'
import { launchEnvironmentOf } from '@panedesk/dsh-launch-environment'
import type { LedgerIdentity } from '@panedesk/dsh-session-ledger'

/** Optional non-secret identity labels supplied by a launcher or profile settings. */
export interface LedgerIdentityOptions {
  /** Workstation or role label. */
  seat?: string
  /** Launcher window label. */
  window?: string
  /** Associated work item label. */
  taskId?: string
}

declare module '@panedesk/cordis' {
  interface Context {
    /** Launcher-owned flags, supplied before the configuration tree mounts. */
    ledgerStartupIdentity?: LedgerIdentityOptions
  }
}

/** Resolve each label through flags, launch environment, then profile settings.
 * @param ctx - runtime with optional launcher snapshots.
 * @param settings - owning agent-loop entry's persisted settings.
 * @returns labels with the highest-priority contributing source, or explicit free attribution.
 */
export function resolveLedgerIdentity(ctx: Context, settings: LedgerIdentityOptions = {}): Omit<LedgerIdentity, 'nodeId'> {
  const environment = launchEnvironmentOf(ctx)
  const startup = ctx.get('ledgerStartupIdentity') ?? {}
  const sources = ['startup', 'environment', 'settings', 'free'] as const
  let highest = 3
  const label = (key: keyof LedgerIdentityOptions, variable: string): string => {
    const values = [startup[key], environment.get(variable)?.value, settings[key]]
    const index = values.findIndex(value => value !== undefined && value.trim().length > 0)
    if (index < 0) return 'free'
    highest = Math.min(highest, index)
    return values[index]?.trim() ?? 'free'
  }
  const seat = label('seat', 'PANEDESK_SEAT'), window = label('window', 'PANEDESK_WINDOW'), taskId = label('taskId', 'PANEDESK_TASK_ID')
  return { seat, window, taskId, identitySource: sources[highest] ?? 'free' }
}
