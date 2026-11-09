/** Host-owned configuration locations for the built-in feature reference. */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@panedesk/cordis'
import { Remote, TypertRemoteService } from '@panedesk/dsh-typert-protocol'
import type {} from '@panedesk/dsh-settings'

declare module '@panedesk/cordis' {
  interface Context { productFeatures: ProductFeatures }
}

/** Read paths without reading or modifying memory files. */
export default class ProductFeatures extends TypertRemoteService {
  static inject = ['settings']
  constructor(ctx: Context) { super(ctx, 'productFeatures') }

  /** Return existing settings and compatible memory directory locations.
   * @returns Absolute paths for the feature reference's open buttons.
   */
  @Remote
  locations(): { configuration: string; projects: string; skills: string; mcp: string; agents: string } {
    return { configuration: this.ctx.settings.documentPath, projects: join(homedir(), '.claude', 'projects'),
      skills: join(homedir(), '.claude', 'skills'), mcp: join(homedir(), '.claude.json'), agents: join(homedir(), '.claude', 'agents') }
  }
}
