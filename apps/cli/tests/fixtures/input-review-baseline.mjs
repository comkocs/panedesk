/** Persist a protected input during the first real Web host launch. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ProtectedInputIntegrity } from '@panedesk/dsh-app-boot'

export const inject = ['profileContext']

/**
 * Capture a durable owner baseline without starting an Agent or a model request.
 * @param {import('@panedesk/cordis').Context} ctx - Real profile launcher context.
 */
export async function apply(ctx) {
  const { cwd, home } = ctx.profileContext
  const input = join(cwd, 'protected-entry.js')
  writeFileSync(input, 'export const approved = true\n')
  const integrity = new ProtectedInputIntegrity(cwd, home)
  integrity.observe(input)
  await integrity.grantWrite()
}
