/** Fails its own mount, carrying the reason a Claude Code agent preset cannot run. */
import type { Context } from '@panedesk/cordis'

/** Cordis plugin name. */
export const name = 'claude-agent-broken'

/** Plugin config: the reason the preset is unusable. */
export interface Config {
  /** Why the definition cannot be routed, shown on the preset. */
  reason: string
}

/**
 * Reject activation so the registry records the preset as broken.
 * @param _ctx - unused; the row exists only to fail.
 * @param config - the reason surfaced as the mount failure.
 */
export function apply(_ctx: Context, config: Config): void {
  throw new Error(config.reason)
}

export default { name, apply }
