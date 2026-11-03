/**
 * Shared path resolution and regular-file validation for model-facing read tools.
 * @module @panedesk/dsh-tool-fs/src/read-target
 */

import type { Context } from '@panedesk/cordis'
import { FsError } from '@panedesk/dsh-fs'
import type { FsInfo, FsTarget } from '@panedesk/dsh-fs'
import type { ToolExecution } from '@panedesk/dsh-tools'
import type { SandboxExecutionPolicy } from '@panedesk/dsh-sandbox'
import type {} from '@panedesk/dsh-sandbox-policy'
import { sessionResolveOptions } from './session-cwd.ts'

/**
 * Resolve a model-supplied path, observe absence, and require a regular file.
 * @param ctx - the plugin context providing filesystem resolution and observation events.
 * @param exec - the current tool execution, including the owning Agent and cancellation.
 * @param requestedPath - the raw path supplied to the tool.
 * @returns the resolved target and its single stat result.
 */
export async function resolveRegularReadTarget(
  ctx: Context,
  exec: ToolExecution,
  requestedPath: string,
): Promise<{ target: FsTarget; info: FsInfo; policy: SandboxExecutionPolicy | undefined }> {
  const resolver = ctx.get('sandboxPolicy')
  if (ctx.fs.sandboxMode !== undefined && resolver === undefined) {
    throw new Error('tool-fs: the mounted filesystem confines but ctx.sandboxPolicy is missing')
  }
  const policy = resolver?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
  const target = await ctx.fs.resolve(requestedPath, await sessionResolveOptions(ctx, exec))
  const info = await ctx.fs.stat(target, exec.signal, policy)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (info.type !== 'file') {
    throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  return { target, info, policy }
}
