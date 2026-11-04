/** Test-only host edit after capturing a protected input, before Agent admission. */
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { ProtectedInputIntegrity } from '@panedesk/dsh-app-boot'

export const inject = ['profileContext']

/**
 * Prepare an unapproved edit without dispatching a model request.
 * @param {import('@panedesk/cordis').Context} ctx - Loader context with isolated profile facts.
 */
export function apply(ctx) {
  const path = join(ctx.profileContext.home, 'refused-input.txt')
  writeFileSync(path, 'approved')
  const integrity = new ProtectedInputIntegrity(ctx.profileContext.home)
  integrity.observe(path)
  writeFileSync(path, 'unapproved')
  ctx.profileContext.inputIntegrity = integrity
}
