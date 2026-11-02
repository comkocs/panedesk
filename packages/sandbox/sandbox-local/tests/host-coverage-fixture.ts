/** Real owner-approved input inventory for native profile hand-off fixtures. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { ProtectedInputIntegrity, type ProfileContext } from '@panedesk/dsh-app-boot'
import { onTestFinished } from 'vitest'

/**
 * Record approved inputs without replacing the production coverage query.
 * @param workspace Writable fixture workspace.
 * @param input Protected input whose approved state is captured now.
 * @param additionalInputs Other protected names approved in the same baseline.
 * @returns Context carrying an owner-local persistent baseline.
 */
export function coveredContext(workspace: string, input: string, ...additionalInputs: string[]): Context {
  const home = mkdtempSync(join(tmpdir(), 'protected-link-owner-'))
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  const integrity = new ProtectedInputIntegrity(workspace, home)
  for (const path of [input, ...additionalInputs]) integrity.observe(path)
  integrity.grantWrite()
  const profile: ProfileContext = {
    name: 'test', dir: workspace, patchPath: input, cwd: workspace, home,
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [],
    telemetryDisabledEnv: undefined, inputIntegrity: integrity,
  }
  const ctx = new Context()
  ctx.provide('profileContext', profile)
  return ctx
}
