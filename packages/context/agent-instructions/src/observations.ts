/** Runtime-only byte observations; provider versions qualify post-write reads, not write-time digests. */
import { createHash } from 'node:crypto'
import type { Context } from '@panedesk/cordis'
import { agentEvents, type Agent } from '@panedesk/dsh-agent'
import type { FileSystem, FsTarget, FsVersion } from '@panedesk/dsh-fs'
import type { InstructionObservation } from './events.ts'

/**
 * Hash bounded raw bytes only when the provider version still matches on both sides of the read.
 * @param fs - filesystem that supplied the observed version.
 * @param target - observed target, without interpreting its opaque key.
 * @param version - version published by the same successful mutation.
 * @param maxBytes - inclusive raw-byte bound.
 * @param signal - observation lifecycle cancellation.
 * @returns exact post-read hash or an explicit unavailable reason.
 */
export async function observeInstructionBytes(
  fs: FileSystem, target: FsTarget, version: FsVersion, maxBytes: number, signal?: AbortSignal,
): Promise<InstructionObservation> {
  const path = fs.processPath(target)
  try {
    if ((await fs.stat(target, signal))?.version !== version) {
      return { path, hash: '', evidence: { status: 'unavailable', reason: 'version-mismatch' } }
    }
    const bytes = await fs.readBytes(target, signal, maxBytes)
    if ((await fs.stat(target, signal))?.version !== version) {
      return { path, hash: '', evidence: { status: 'unavailable', reason: 'version-mismatch' } }
    }
    return { path, hash: createHash('sha256').update(bytes).digest('hex'), evidence: { status: 'available' } }
  } catch (_error: unknown) {
    signal?.throwIfAborted()
    return { path, hash: '', evidence: { status: 'unavailable', reason: 'read-unavailable' } }
  }
}

/**
 * Register successful write observations and their awaitable settlement point.
 * @param ctx - plugin effect owner.
 * @param maxBytes - bound shared with instruction source reads.
 */
export function installInstructionWriteObservations(ctx: Context, maxBytes: number): void {
  const versions = new WeakMap<object, { target: FsTarget; version: FsVersion }>()
  const pending = new Map<Agent, Promise<void>>()
  const lifecycle = new AbortController()
  ctx.on('fs/observed', (target, observation, actor) => {
    if (actor !== undefined && observation.kind === 'present') versions.set(actor, { target, version: observation.version })
  })
  ctx.on('tools/result', (exec, result) => {
    const observed = versions.get(exec)
    versions.delete(exec)
    const agent = exec.agent
    if (result.isError || agent === undefined || (exec.name !== 'write' && exec.name !== 'edit')) return
    const args = exec.arguments
    if (typeof args !== 'object' || args === null || !('file_path' in args) || typeof args.file_path !== 'string') return
    const path = args.file_path
    const fs = ctx.get('fs')
    const previous = pending.get(agent) ?? Promise.resolve()
    const task = previous.then(async () => {
      const file: InstructionObservation = observed === undefined || fs === undefined
        ? { path, hash: '', evidence: { status: 'unavailable', reason: 'version-unavailable' } }
        : await observeInstructionBytes(fs, observed.target, observed.version, maxBytes, lifecycle.signal)
      if (!lifecycle.signal.aborted) agentEvents(ctx, agent).emit('instructions/written', { file })
    }).catch((error: unknown) => {
      if (!lifecycle.signal.aborted) ctx.logger.warn('Instruction write observation failed: %o', error)
    })
    pending.set(agent, task)
    void task.then(() => { if (pending.get(agent) === task) pending.delete(agent) })
  })
  ctx.on('instructions/writes-settling', async ({ agent }) => {
    let task: Promise<void> | undefined
    while ((task = pending.get(agent)) !== undefined) await task
  })
  ctx.effect(() => async () => {
    lifecycle.abort()
    await Promise.all(pending.values())
    pending.clear()
  }, 'agent-instructions.writeObservations')
}
