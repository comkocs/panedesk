import { Context } from '@panedesk/cordis'
import Sandbox from '@panedesk/dsh-sandbox-local'
import SandboxPolicy from '@panedesk/dsh-sandbox-policy'
import SessionProjections from '@panedesk/dsh-session-projection'
import Subprocess from '@panedesk/dsh-subprocess-local'
import { onTestFinished } from 'vitest'
import type { SandboxMode } from '@panedesk/dsh-sandbox'

/** Mount the Python runtime's policy and confinement providers with owned teardown. */
export async function createRuntimeContext(policy: { mode?: SandboxMode; workspaceRoot?: string } = {}): Promise<Context> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Subprocess)
  // Preserve process-group fallback coverage independently of host systemd availability.
  if ((policy.mode ?? 'danger-full-access') === 'danger-full-access') (ctx.subprocess as Subprocess).internals = { platform: 'darwin' }
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', ...policy })
  return ctx
}
