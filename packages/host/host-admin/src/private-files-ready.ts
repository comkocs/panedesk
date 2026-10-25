/** Startup visibility waits are bounded and owned by the consuming Cordis fiber. */
import type { Context } from '@panedesk/cordis'
import type { PrivateFiles } from './private-files.ts'

/** Wait for an active private-file provider without reading loading implementations.
 * @param ctx - Consumer lifecycle and isolation scope.
 * @param name - Required private-file service name.
 * @param timeoutMs - Explicit startup deadline in milliseconds.
 * @param read - Typed strict lookup in the consumer's service scope.
 * @returns Active factory; missing providers and consumer disposal reject startup.
 */
export async function waitForPrivateFiles(ctx: Context, name: string, timeoutMs: number,
  read: () => ((directory: string) => PrivateFiles) | undefined): Promise<(directory: string) => PrivateFiles> {
  const available = read()
  if (available !== undefined) return available
  return new Promise((resolve, reject) => {
    const finish = (factory?: (directory: string) => PrivateFiles) => {
      clearTimeout(timer)
      unwatch()
      undispose()
      if (factory === undefined) reject(new Error(`${name} unavailable`))
      else resolve(factory)
    }
    const timer = setTimeout(() => { finish() }, timeoutMs)
    const unwatch = ctx.on('internal/service', (changed) => {
      if (changed !== name) return
      const factory = read()
      if (factory !== undefined) finish(factory)
    })
    const undispose = ctx.on('internal/plugin', (fiber) => {
      if (fiber.uid === null && fiber === ctx.fiber) finish()
    })
    const factory = read()
    if (factory !== undefined) finish(factory)
  })
}
