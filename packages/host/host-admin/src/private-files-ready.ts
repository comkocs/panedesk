/** Startup visibility waits are bounded and owned by the consuming Cordis fiber. */
import type { Context } from '@panedesk/cordis'
import type { PrivateFiles } from './private-files.ts'

/** Consumer disposal cancels visibility waiting without reporting a provider failure. */
export class PrivateFilesWaitCancelled extends Error {}

/** Wait for an active private-file provider without reading loading implementations.
 * @param ctx - Consumer lifecycle and isolation scope.
 * @param name - Required private-file service name.
 * @param timeoutMs - Explicit startup deadline in milliseconds.
 * @param read - Typed strict lookup in the consumer's service scope.
 * @returns Active factory; missing providers reject, while disposal rejects with PrivateFilesWaitCancelled.
 */
export async function waitForPrivateFiles(ctx: Context, name: string, timeoutMs: number,
  read: () => ((directory: string) => PrivateFiles) | undefined): Promise<(directory: string) => PrivateFiles> {
  const available = read()
  if (available !== undefined) return available
  return new Promise((resolve, reject) => {
    const finish = (factory?: (directory: string) => PrivateFiles, cancelled = false) => {
      clearTimeout(timer)
      unwatch()
      undispose()
      if (cancelled) reject(new PrivateFilesWaitCancelled(`${name} wait cancelled`))
      else if (factory === undefined) reject(new Error(`${name} unavailable`))
      else resolve(factory)
    }
    const timer = setTimeout(() => { finish() }, timeoutMs)
    const unwatch = ctx.on('internal/service', (changed) => {
      if (changed !== name) return
      const factory = read()
      if (factory !== undefined) finish(factory)
    })
    const undispose = ctx.on('internal/plugin', (fiber) => {
      if (fiber.uid === null && fiber === ctx.fiber) finish(undefined, true)
    })
    const factory = read()
    if (factory !== undefined) finish(factory)
  })
}
