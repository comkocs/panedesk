/** Declared delivery checks use the execution-world filesystem and never replace task output. */
import type { Context } from '@panedesk/cordis'
import { FsError, type FileSystem } from '@panedesk/dsh-fs'
import type { Agent } from '@panedesk/dsh-agent'
import type { LedgerRunFinish } from '@panedesk/dsh-session-ledger'
import { SubagentError } from './error.ts'

/** Captured workspace and canonical delivery paths, revalidated at settlement. */
export interface DeliveryPlan {
  readonly fs: FileSystem
  readonly root: string
  readonly paths: readonly string[]
}

async function checkedTarget(fs: FileSystem, root: string, path: string) {
  const workspace = await fs.resolve(root)
  const target = await fs.resolve(path, { cwd: root })
  if (!fs.contains(workspace, target) || fs.processPath(target) === fs.processPath(workspace)) {
    throw new SubagentError('Delivery path escapes the authorized workspace', 'DELIVERY_OUTSIDE_WORKSPACE')
  }
  const info = await fs.stat(target)
  if (info !== undefined && info.type !== 'file') {
    throw new SubagentError('Delivery path is not a regular file', 'DELIVERY_NOT_FILE')
  }
  return target
}

/** Validate declared files before execution; omission does not require a filesystem.
 * @param ctx Runtime context.
 * @param parent Delegating Agent supplying immutable workspace authority.
 * @param paths Declared files; omission means no checks.
 * @returns Canonical plan, or undefined when no files were declared.
 */
export async function prepareDeliveries(ctx: Context, parent: Agent, paths?: readonly string[]): Promise<DeliveryPlan | undefined> {
  if (paths === undefined || paths.length === 0) return undefined
  const fs = ctx.get('fs')
  const root = parent.ctx.get('sandboxPolicy')?.resolve({ session: parent.session }).workspaceRoot ?? parent.session.header.cwd
  if (fs === undefined || root === undefined) throw new SubagentError('Delivery checks require a filesystem and an authorized workspace', 'DELIVERY_UNAVAILABLE')
  const resolved: string[] = []
  for (const path of paths) {
    if (!path.trim()) throw new SubagentError('Delivery path must not be empty', 'DELIVERY_INVALID_PATH')
    resolved.push(fs.processPath(await checkedTarget(fs, root, path)))
  }
  return { fs, root: fs.processPath(await fs.resolve(root)), paths: [...new Set(resolved)] }
}

/** Observe every declared file without modifying it; inaccessible and missing remain distinct.
 * @param plan Captured delivery plan, absent when checks were not requested.
 * @returns Aggregate state and per-file observations.
 */
export async function checkDeliveries(plan?: DeliveryPlan): Promise<{ state: LedgerRunFinish['deliveryState']; files: { path: string; state: 'present' | 'missing' | 'uncheckable' }[] }> {
  if (plan === undefined) return { state: 'not-requested', files: [] }
  const files = await Promise.all(plan.paths.map(async (path) => {
    try {
      const target = await checkedTarget(plan.fs, plan.root, path)
      return { path, state: await plan.fs.stat(target) === undefined ? 'missing' as const : 'present' as const }
    } catch (_error) {
      // A failed observation cannot establish absence or authorize a sidecar write.
      return { path, state: 'uncheckable' as const }
    }
  }))
  const state = files.some(file => file.state === 'uncheckable') ? 'uncheckable'
    : files.some(file => file.state === 'missing') ? 'missing' : 'present'
  return { state, files }
}

/** Remove credential assignments and network addresses from provider diagnostics.
 * @param diagnostic Runtime-owned error text, never assistant output.
 * @returns Bounded safe text for notifications and sidecars.
 */
export function sanitizeDiagnostic(diagnostic: string): string {
  return diagnostic
    .replace(/\b(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/\b(api[-_]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted]')
    .replace(/\b(?:[a-f\d]{0,4}:){2,}[a-f\d:]*\b/gi, '[redacted]')
    .slice(0, 1024)
}

/** Write sanitized failure text beside, never into, declared outputs using exclusive creation.
 * @param plan Captured workspace and files.
 * @param runId Unique runtime run identity used when the ordinary sidecar exists.
 * @param diagnostic Provider-owned diagnostic, never assistant output.
 * @returns Actual sidecar paths; failures propagate without touching partial deliveries.
 */
export async function writeErrorArtifacts(plan: DeliveryPlan, runId: string, diagnostic: string): Promise<string[]> {
  const text = sanitizeDiagnostic(diagnostic)
  const written: string[] = []
  for (const path of plan.paths) {
    await checkedTarget(plan.fs, plan.root, path)
    for (const candidate of [`${path}.err.txt`, `${path}.err.${runId}.txt`]) {
      const target = await checkedTarget(plan.fs, plan.root, candidate)
      if (plan.paths.includes(plan.fs.processPath(target))) {
        throw new SubagentError('Error artifact collides with a declared delivery', 'DELIVERY_ARTIFACT_COLLISION')
      }
      try {
        await plan.fs.writeText(target, text, { kind: 'createIfAbsent' }, undefined,
          { mode: 'workspace-write', workspaceRoot: plan.root })
        written.push(plan.fs.processPath(target))
        break
      } catch (error) {
        if (error instanceof FsError && error.code === 'FS_NOT_OBSERVED' && candidate === `${path}.err.txt`) continue
        throw error
      }
    }
  }
  return written
}
